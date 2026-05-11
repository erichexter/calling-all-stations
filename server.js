/**
 * switchboard/server.js
 *
 * A lightweight multi-agent coordination server built on MCP Streamable HTTP.
 *
 * Agents register, send messages, ask questions, and receive directives through
 * a shared registry + inbox system. Any HTTP client can participate — MCP is
 * the native interface for Claude agents, but the REST endpoints are
 * vendor-neutral so any agent runtime can use them directly.
 *
 * MCP endpoint:  POST/GET/DELETE http://localhost:PORT/mcp
 * REST endpoints: /register  /deregister/:id  /send  /send-directive
 *                 /check-inbox  /status  /registry  /health
 *
 * Configuration (env vars):
 *   PORT            — HTTP port (default: 8788)
 *   BIND_HOST       — bind address (default: 0.0.0.0)
 *   STATE_FILE      — path to persistence JSON (default: ./switchboard-state.json)
 */

import { Server }                        from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer }                  from 'node:http'
import fs                                from 'node:fs'
import path                              from 'node:path'
import crypto                            from 'node:crypto'

const PORT       = Number(process.env.PORT ?? 8788)
const BIND_HOST  = process.env.BIND_HOST ?? '0.0.0.0'
const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'switchboard-state.json')

// -- Agent registry (in-memory + file-backed) --------------------------------

const registry = new Map()   // session_id -> agent_info
const inboxes  = new Map()   // session_id -> [directive, ...]

function persistState() {
  try {
    const inboxSnapshot = {}
    for (const [id, directives] of inboxes) {
      const pending = directives.filter(d => !d.delivered)
      if (pending.length > 0) inboxSnapshot[id] = pending
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      registry: Object.fromEntries(registry),
      inboxes:  inboxSnapshot,
      ts: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch (e) {
    process.stderr.write(`[switchboard] persistState error: ${e.message}\n`)
  }
}

function hydrateState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (state.registry) {
      for (const [id, info] of Object.entries(state.registry))
        registry.set(id, { ...info, status: 'stale' })
    }
    if (state.inboxes) {
      for (const [id, directives] of Object.entries(state.inboxes))
        inboxes.set(id, directives)
    }
    process.stderr.write(`[switchboard] Hydrated ${registry.size} sessions from state\n`)
  } catch {}
}

hydrateState()
setInterval(persistState, 30_000)

// -- MCP session management --------------------------------------------------

const mcpSessions = new Map()   // MCP transport session ID -> { transport, server }
let seq = 0

function broadcastNotification(method, params) {
  for (const [, { server }] of mcpSessions) {
    try { server.notification({ method, params }) } catch {}
  }
}

function autoRegister(session_id, via) {
  if (!registry.has(session_id)) {
    registry.set(session_id, {
      session_id, issue_number: null, label: 'auto-registered',
      started_at: new Date().toISOString(), status: 'running',
      last_status_at: new Date().toISOString(), current_step: 'starting',
      waiting_for_answer: false,
    })
    inboxes.set(session_id, [])
    persistState()
    process.stderr.write(`[switchboard] auto-registered ${session_id.slice(0,8)} via ${via}\n`)
  }
}

function createMcpServer() {
  const server = new Server(
    { name: 'switchboard', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: `Switchboard is a multi-agent coordination server.

When you receive a <channel source="switchboard"> notification:
- event="agent_status": log the update; the sending agent has changed step.
- event="agent_question": an agent needs an answer. Call send_directive with type="answer" immediately. If you cannot answer, escalate appropriately.
- event="issue_complete": an agent has finished its task.
- event="ping": acknowledge and continue.

Do not wait for the next scheduled tick — handle channel events immediately.`,
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'check_inbox',
        description: 'Check for pending directives addressed to your session. Call between major steps. Returns unread directives and marks them delivered.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Your session ID' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'send_directive',
        description: 'Send a directive to another registered agent. The message lands in their inbox and is returned on their next check_inbox call.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Target agent session ID' },
            type:       { type: 'string', enum: ['redirect', 'answer', 'abort', 'message'], description: 'Directive type' },
            body:       { type: 'object', description: 'Directive payload' },
          },
          required: ['session_id', 'type', 'body'],
        },
      },
      {
        name: 'send',
        description: 'Broadcast a status update or question to all connected MCP sessions. For agent_question events, another agent answers via send_directive and you poll check_inbox for the reply.',
        inputSchema: {
          type: 'object',
          properties: {
            event:      { type: 'string', enum: ['agent_status', 'agent_question', 'issue_complete', 'ping'], description: 'Event type' },
            session_id: { type: 'string', description: 'Your session ID' },
            message:    { type: 'string', description: 'Status message (for agent_status / ping)' },
            question:   { type: 'string', description: 'Question text (for agent_question)' },
            blocking:   { type: 'boolean', description: 'true for agent_question — signals you will poll check_inbox for an answer' },
            step:       { type: 'string', description: 'Current step label (updates your registry entry)' },
          },
          required: ['event', 'session_id'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params

    if (name === 'check_inbox') {
      const { session_id } = args
      autoRegister(session_id, 'MCP check_inbox')
      const pending = (inboxes.get(session_id) ?? []).filter(d => !d.delivered)
      for (const d of pending) d.delivered = true
      process.stderr.write(`[switchboard] check_inbox ${session_id.slice(0,8)}: ${pending.length} directive(s)\n`)
      return {
        content: [{ type: 'text', text: JSON.stringify({
          directives: pending.map(d => ({ id: d.id, type: d.type, body: d.body, sent_at: d.sent_at }))
        }) }]
      }
    }

    if (name === 'send_directive') {
      const { session_id, type, body } = args
      if (!registry.has(session_id))
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'session_not_found' }) }] }
      const directive = { id: crypto.randomUUID(), type, body, sent_at: new Date().toISOString(), delivered: false }
      if (!inboxes.has(session_id)) inboxes.set(session_id, [])
      inboxes.get(session_id).push(directive)
      if (type === 'answer') {
        const entry = registry.get(session_id)
        if (entry) { entry.waiting_for_answer = false; entry.last_status_at = new Date().toISOString() }
      }
      persistState()
      process.stderr.write(`[switchboard] directive -> ${session_id.slice(0,8)}: ${type}\n`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, directive_id: directive.id }) }] }
    }

    if (name === 'send') {
      const { event: eventType, session_id, message, question, blocking, step } = args
      autoRegister(session_id, `MCP send(${eventType})`)
      const entry = registry.get(session_id)
      if (entry) {
        if (step) { entry.current_step = step; entry.last_status_at = new Date().toISOString() }
        if (eventType === 'agent_question' && blocking) {
          entry.waiting_for_answer = true
          entry.question    = question ?? null
          entry.question_at = new Date().toISOString()
        }
      }
      const id      = `m${Date.now()}-${++seq}`
      const content = message ?? question ?? `${eventType}:${session_id}`
      broadcastNotification('notifications/message', {
        content,
        meta: {
          message_id: id, ts: new Date().toISOString(),
          event: eventType, session_id,
          question: question ?? null, blocking: blocking ?? false, step: step ?? null,
        },
      })
      process.stderr.write(`[switchboard] send event=${eventType} session=${session_id.slice(0,8)}\n`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: id }) }] }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown tool' }) }], isError: true }
  })

  return server
}

// -- HTTP server -------------------------------------------------------------

const httpServer = createServer(async (req, res) => {

  // MCP Streamable HTTP endpoint
  if (req.url === '/mcp') {
    const sessionId = req.headers['mcp-session-id']

    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      await new Promise(r => req.on('end', r))
      let parsedBody
      try { parsedBody = JSON.parse(body) } catch {}

      if (sessionId && mcpSessions.has(sessionId)) {
        await mcpSessions.get(sessionId).transport.handleRequest(req, res, parsedBody)
      } else if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            mcpSessions.set(sid, { transport, server: mcpServer })
            process.stderr.write(`[switchboard] MCP session init: ${sid.slice(0,8)} (total: ${mcpSessions.size})\n`)
          },
        })
        let mcpServer
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) {
            mcpSessions.delete(sid)
            process.stderr.write(`[switchboard] MCP session closed: ${sid.slice(0,8)} (total: ${mcpSessions.size})\n`)
          }
        }
        mcpServer = createMcpServer()
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
      } else {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown session ID' }))
      }
      return
    }

    if (req.method === 'GET') {
      if (sessionId && mcpSessions.has(sessionId)) {
        await mcpSessions.get(sessionId).transport.handleRequest(req, res)
      } else {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }))
      }
      return
    }

    if (req.method === 'DELETE') {
      if (sessionId && mcpSessions.has(sessionId)) {
        await mcpSessions.get(sessionId).transport.handleRequest(req, res)
      } else {
        res.writeHead(404); res.end()
      }
      return
    }

    res.writeHead(405); res.end('Method Not Allowed')
    return
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', port: PORT, agents: registry.size, mcp_sessions: mcpSessions.size }))
    return
  }

  // Registry
  if (req.method === 'GET' && req.url === '/registry') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ agents: Object.fromEntries(registry) }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method Not Allowed'); return
  }

  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let payload
    try { payload = JSON.parse(body) } catch { payload = { message: body.trim() } }

    if (req.url === '/register') {
      const { session_id, issue_number, label, started_at } = payload
      if (session_id) {
        registry.set(session_id, {
          session_id, issue_number: issue_number ?? null, label: label ?? 'registered',
          started_at: started_at ?? new Date().toISOString(),
          status: 'running', last_status_at: new Date().toISOString(), current_step: 'starting',
        })
        inboxes.set(session_id, [])
        persistState()
        process.stderr.write(`[switchboard] registered ${session_id.slice(0,8)}\n`)
      }
      res.writeHead(204); res.end(); return
    }

    if (req.url.startsWith('/deregister/')) {
      const session_id = req.url.replace('/deregister/', '')
      registry.delete(session_id)
      inboxes.delete(session_id)
      persistState()
      process.stderr.write(`[switchboard] deregistered ${session_id.slice(0,8)}\n`)
      res.writeHead(204); res.end(); return
    }

    if (req.url === '/check-inbox') {
      const { session_id } = payload
      autoRegister(session_id, 'HTTP /check-inbox')
      const pending = (inboxes.get(session_id) ?? []).filter(d => !d.delivered)
      for (const d of pending) d.delivered = true
      process.stderr.write(`[switchboard] HTTP check-inbox ${session_id.slice(0,8)}: ${pending.length} directive(s)\n`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ directives: pending.map(d => ({ id: d.id, type: d.type, body: d.body, sent_at: d.sent_at })) }))
      return
    }

    if (req.url === '/send') {
      const { event: eventType, session_id, message, question, blocking, step } = payload
      if (session_id) autoRegister(session_id, `HTTP /send(${eventType})`)
      const entry = session_id ? registry.get(session_id) : null
      if (entry) {
        if (step) { entry.current_step = step; entry.last_status_at = new Date().toISOString() }
        if (eventType === 'agent_question' && blocking) {
          entry.waiting_for_answer = true
          entry.question    = question ?? null
          entry.question_at = new Date().toISOString()
        }
      }
      const id      = `m${Date.now()}-${++seq}`
      const content = message ?? question ?? `${eventType}:${session_id}`
      broadcastNotification('notifications/message', {
        content,
        meta: {
          message_id: id, ts: new Date().toISOString(),
          event: eventType, session_id,
          question: question ?? null, blocking: blocking ?? false, step: step ?? null,
        },
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message_id: id }))
      process.stderr.write(`[switchboard] HTTP send event=${eventType} session=${session_id?.slice(0,8)}\n`)
      return
    }

    if (req.url === '/send-directive') {
      const { session_id, type, body: directiveBody } = payload
      if (!session_id || !type || !directiveBody) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing session_id, type, or body' })); return
      }
      if (!registry.has(session_id)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'session_not_found' })); return
      }
      const directive = { id: crypto.randomUUID(), type, body: directiveBody, sent_at: new Date().toISOString(), delivered: false }
      if (!inboxes.has(session_id)) inboxes.set(session_id, [])
      inboxes.get(session_id).push(directive)
      if (type === 'answer') {
        const entry = registry.get(session_id)
        if (entry) { entry.waiting_for_answer = false; entry.last_status_at = new Date().toISOString() }
      }
      persistState()
      process.stderr.write(`[switchboard] HTTP send-directive -> ${session_id.slice(0,8)}: ${type}\n`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, directive_id: directive.id }))
      return
    }

    if (req.url === '/status') {
      const { session_id, step } = payload
      if (session_id && registry.has(session_id)) {
        const entry = registry.get(session_id)
        entry.current_step = step
        entry.last_status_at = new Date().toISOString()
      }
      res.writeHead(204); res.end(); return
    }

    // Default: broadcast notification
    const id      = `m${Date.now()}-${++seq}`
    const content = payload.message ?? JSON.stringify(payload)
    broadcastNotification('notifications/message', {
      content,
      meta: { message_id: id, ts: new Date().toISOString(), event: payload.event ?? 'message', ...payload },
    })
    res.writeHead(204); res.end()
    process.stderr.write(`[switchboard] broadcast: ${content.slice(0, 120)}\n`)
  })
})

httpServer.listen(PORT, BIND_HOST, () => {
  process.stderr.write(`[switchboard] v1.0.0 listening on ${BIND_HOST}:${PORT} — MCP at /mcp\n`)
})
