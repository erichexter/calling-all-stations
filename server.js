/**
 * calling-all-stations/server.js
 *
 * A lightweight multi-agent coordination server supporting both MCP Streamable
 * HTTP and the Agent-to-Agent (A2A) protocol (v1.0).
 *
 * Agents register, send messages, ask questions, and receive directives through
 * a shared registry + inbox system. Supports three client interfaces:
 *   - MCP Streamable HTTP  — native for Claude and MCP-compatible agents
 *   - A2A JSON-RPC 2.0     — interoperates with LangGraph, Bedrock, Vertex AI, etc.
 *   - REST HTTP            — vendor-neutral fallback for any HTTP client
 *
 * Endpoints:
 *   MCP:  POST/GET/DELETE /mcp
 *   A2A:  POST /a2a  (coordinator)
 *         POST /agents/:id/a2a  (per-agent proxy)
 *         GET  /.well-known/agent-card.json
 *         GET  /agents/  (directory)
 *         GET  /agents/:id/agent-card.json
 *   REST: /register  /deregister/:id  /send  /send-directive
 *         /check-inbox  /status  /registry  /health  /skills
 *
 * Configuration (env vars):
 *   PORT        — HTTP port (default: 8788)
 *   BIND_HOST   — bind address (default: 0.0.0.0)
 *   STATE_FILE  — persistence JSON path (default: ./switchboard-state.json)
 *   SERVER_URL  — public base URL for agent cards (default: http://localhost:PORT)
 */

import { Server }                        from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer }                  from 'node:http'
import fs                                from 'node:fs'
import path                              from 'node:path'
import crypto                            from 'node:crypto'

export const PORT       = Number(process.env.PORT ?? 8788)
export const BIND_HOST  = process.env.BIND_HOST ?? '0.0.0.0'
export const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'switchboard-state.json')

// Exported for tests — overridden via SERVER_URL env var
export function getServerUrl() {
  return process.env.SERVER_URL ?? `http://localhost:${PORT}`
}

// ---------------------------------------------------------------------------
// Agent registry (in-memory + file-backed)
// ---------------------------------------------------------------------------

export const registry = new Map()   // session_id -> agent_info
export const inboxes  = new Map()   // session_id -> [directive, ...]
export const tasks    = new Map()   // task_id    -> a2a task object

export function persistState() {
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

export function hydrateState() {
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

export function autoRegister(session_id, via, skills = []) {
  if (!registry.has(session_id)) {
    registry.set(session_id, {
      session_id,
      issue_number: null,
      label: 'auto-registered',
      started_at: new Date().toISOString(),
      status: 'running',
      last_status_at: new Date().toISOString(),
      current_step: 'starting',
      waiting_for_answer: false,
      skills: Array.isArray(skills) ? skills : [],
    })
    inboxes.set(session_id, [])
    persistState()
    process.stderr.write(`[switchboard] auto-registered ${session_id.slice(0,8)} via ${via}\n`)
  }
}

// ---------------------------------------------------------------------------
// A2A Agent Card generation
// ---------------------------------------------------------------------------

export function buildCoordinatorCard() {
  const base = getServerUrl()
  return {
    protocolVersion: '1.0',
    name: 'calling-all-stations',
    description:
      'Multi-agent coordination hub — MCP Streamable HTTP + A2A protocol. ' +
      'Agents register, broadcast events, ask questions, and receive directed replies. ' +
      'Bridges MCP-native agents (Claude) with A2A-compatible runtimes (LangGraph, Bedrock, Vertex AI).',
    url: `${base}/a2a`,
    humanReadableId: 'calling-all-stations/coordinator',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extended_agent_card: false,
    },
    skills: [
      {
        id: 'broadcast',
        name: 'Broadcast',
        description: 'Send an event to all connected MCP agents instantly via SSE push',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [{ input: '{"event":"announce","message":"deploy complete"}' }],
      },
      {
        id: 'route-directive',
        name: 'Route Directive',
        description: 'Send a directed message to a specific registered agent by session_id',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'query-registry',
        name: 'Query Registry',
        description: 'List all currently registered agents, their status, and declared skills',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
  }
}

export function buildAgentCard(session_id) {
  const entry = registry.get(session_id)
  if (!entry) return null
  const base = getServerUrl()
  const skills = Array.isArray(entry.skills) && entry.skills.length > 0
    ? entry.skills
    : [{
        id: 'general',
        name: entry.label ?? 'Agent',
        description: 'General-purpose agent (no skills declared on registration)',
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
      }]
  return {
    protocolVersion: '1.0',
    name: entry.label ?? session_id,
    description: `Agent proxied via calling-all-stations coordinator. Status: ${entry.status}.`,
    url: `${base}/agents/${session_id}/a2a`,
    humanReadableId: `calling-all-stations/${session_id}`,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills,
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    'x-proxy': {
      coordinator: base,
      session_id,
      transport: 'mcp-push',
      status: entry.status,
      current_step: entry.current_step,
    },
  }
}

export function buildAgentDirectory() {
  const base = getServerUrl()
  return {
    coordinator: `${base}/.well-known/agent-card.json`,
    agents: Array.from(registry.values()).map(entry => ({
      session_id: entry.session_id,
      label: entry.label,
      status: entry.status,
      current_step: entry.current_step,
      skills: Array.isArray(entry.skills) ? entry.skills.map(s => s.id) : [],
      agent_card_url: `${base}/agents/${entry.session_id}/agent-card.json`,
      a2a_url: `${base}/agents/${entry.session_id}/a2a`,
    })),
  }
}

export function buildSkillDirectory() {
  const skillMap = new Map()
  for (const entry of registry.values()) {
    if (!Array.isArray(entry.skills)) continue
    for (const skill of entry.skills) {
      if (!skillMap.has(skill.id)) {
        skillMap.set(skill.id, { ...skill, agents: [] })
      }
      skillMap.get(skill.id).agents.push({
        session_id: entry.session_id,
        label: entry.label,
        status: entry.status,
      })
    }
  }
  return { skills: Array.from(skillMap.values()) }
}

// ---------------------------------------------------------------------------
// A2A Part / Artifact schema helpers (spec: A2A v1.0)
// ---------------------------------------------------------------------------

const VALID_PART_KINDS = ['text', 'raw', 'url', 'data']

/**
 * Normalize a Part to spec shape: { kind, text|raw|url|data, mediaType?, filename? }
 * Accepts legacy { text: "..." } format and upgrades it.
 */
export function normalizePart(part) {
  if (!part || typeof part !== 'object') return null
  // Already spec-compliant
  if (VALID_PART_KINDS.includes(part.kind)) return part
  // Legacy: { text: "..." } → { kind: "text", text: "..." }
  if (typeof part.text === 'string') return { kind: 'text', text: part.text, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }
  // Legacy: { data: ... } → { kind: "data", data: ... }
  if (part.data !== undefined) return { kind: 'data', data: part.data, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }
  // Legacy: { url: "..." } → { kind: "url", url: part.url }
  if (typeof part.url === 'string') return { kind: 'url', url: part.url, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }
  return null
}

/**
 * Normalize an Artifact to spec shape: { artifactId, name, description, parts[], metadata?, extensions? }
 */
export function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return null
  return {
    artifactId: artifact.artifactId ?? artifact.id ?? crypto.randomUUID(),
    name: artifact.name ?? 'artifact',
    description: artifact.description ?? '',
    parts: Array.isArray(artifact.parts)
      ? artifact.parts.map(normalizePart).filter(Boolean)
      : (artifact.data !== undefined ? [{ kind: 'data', data: artifact.data, mediaType: artifact.mimeType }] : []),
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  }
}

/**
 * Extract plain text from spec-compliant or legacy parts array.
 */
export function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return ''
  return parts
    .map(p => {
      if (!p) return ''
      if (p.kind === 'text') return p.text ?? ''
      if (typeof p.text === 'string') return p.text // legacy
      return ''
    })
    .join(' ')
    .trim()
}

// ---------------------------------------------------------------------------
// A2A task management
// ---------------------------------------------------------------------------

const TASK_TTL_MS = 60 * 60 * 1000 // 1 hour

export function createTask(sessionId, message, contextId = null) {
  const id = crypto.randomUUID()
  const task = {
    id,
    contextId: contextId ?? crypto.randomUUID(),
    session_id: sessionId,
    status: { state: 'submitted' },
    message,
    result: null,
    artifacts: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  tasks.set(id, task)
  return task
}

export function updateTask(taskId, patch) {
  const task = tasks.get(taskId)
  if (!task) return null
  Object.assign(task, patch, { updated_at: new Date().toISOString() })
  return task
}

export function getTask(taskId) {
  return tasks.get(taskId) ?? null
}

export function pruneExpiredTasks() {
  const cutoff = Date.now() - TASK_TTL_MS
  for (const [id, task] of tasks) {
    if (new Date(task.created_at).getTime() < cutoff) tasks.delete(id)
  }
}

// ---------------------------------------------------------------------------
// A2A JSON-RPC handler
// ---------------------------------------------------------------------------

let seq = 0

export const SUPPORTED_A2A_VERSIONS = ['1.0']

export function validateA2aVersion(versionHeader) {
  if (!versionHeader) return null // missing — warn but allow for now
  if (!SUPPORTED_A2A_VERSIONS.includes(versionHeader)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32003, message: `Unsupported A2A-Version: ${versionHeader}. Supported: ${SUPPORTED_A2A_VERSIONS.join(', ')}` } }
  }
  return null
}

export function handleA2aRequest(payload, sessionId, baseUrl, options = {}) {
  const { jsonrpc, id, method, params } = payload
  const { a2aVersion } = options

  const versionError = a2aVersion !== undefined ? validateA2aVersion(a2aVersion) : null
  if (versionError) return { ...versionError, id: id ?? null }

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  }

  // A2A spec method names (kept alongside legacy aliases for backward compat)
  if (method === 'tasks/get' || method === 'getTask') {
    const taskId = params?.taskId ?? params?.id
    if (!taskId) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing taskId' } }
    }
    const task = getTask(taskId)
    if (!task) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } }
    }
    return { jsonrpc: '2.0', id, result: { task } }
  }

  if (method === 'cancelTask') {
    const taskId = params?.taskId ?? params?.id
    if (!taskId) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing taskId' } }
    }
    const task = getTask(taskId)
    if (!task) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } }
    }
    const terminal = ['completed', 'failed', 'canceled', 'rejected']
    if (terminal.includes(task.status.state)) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `Task already in terminal state: ${task.status.state}` } }
    }
    updateTask(taskId, { status: { state: 'canceled' } })
    process.stderr.write(`[switchboard] A2A task ${taskId.slice(0,8)} canceled\n`)
    return { jsonrpc: '2.0', id, result: { task: getTask(taskId) } }
  }

  if (method === 'listTasks') {
    const { contextId, status: statusFilter, limit = 100, offset = 0 } = params ?? {}
    let results = Array.from(tasks.values())
    if (contextId) results = results.filter(t => t.contextId === contextId)
    if (statusFilter) results = results.filter(t => t.status.state === statusFilter)
    const page = results.slice(offset, offset + limit)
    return { jsonrpc: '2.0', id, result: { tasks: page, total: results.length, offset, limit } }
  }

  if (method === 'message/send' || method === 'sendMessage') {
    const message = params?.message
    if (!message) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing message' } }
    }

    // If routing to a specific agent (per-agent proxy endpoint sets sessionId)
    if (sessionId) {
      if (!registry.has(sessionId)) {
        return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Agent not found' } }
      }
      const task = createTask(sessionId, message, params?.contextId ?? null)
      const directive = {
        id: crypto.randomUUID(),
        type: 'a2a_message',
        body: { task_id: task.id, message },
        sent_at: new Date().toISOString(),
        delivered: false,
      }
      if (!inboxes.has(sessionId)) inboxes.set(sessionId, [])
      inboxes.get(sessionId).push(directive)
      updateTask(task.id, { status: { state: 'working' } })
      persistState()
      process.stderr.write(`[switchboard] A2A task ${task.id.slice(0,8)} queued for agent ${sessionId.slice(0,8)}\n`)
      return { jsonrpc: '2.0', id, result: { task } }
    }

    // Coordinator: extract skill or broadcast
    const skill = params?.skill
    const text = Array.isArray(message.parts)
      ? extractTextFromParts(message.parts)
      : (message.text ?? JSON.stringify(message))

    if (skill) {
      // Skill-based routing — find first running agent with that skill
      const target = Array.from(registry.values()).find(
        e => e.status === 'running' && Array.isArray(e.skills) && e.skills.some(s => s.id === skill)
      )
      if (!target) {
        return { jsonrpc: '2.0', id, error: { code: -32001, message: `No running agent with skill: ${skill}` } }
      }
      const task = createTask(target.session_id, message, params?.contextId ?? null)
      const directive = {
        id: crypto.randomUUID(),
        type: 'a2a_message',
        body: { task_id: task.id, message },
        sent_at: new Date().toISOString(),
        delivered: false,
      }
      if (!inboxes.has(target.session_id)) inboxes.set(target.session_id, [])
      inboxes.get(target.session_id).push(directive)
      updateTask(task.id, { status: { state: 'working' } })
      persistState()
      process.stderr.write(`[switchboard] A2A skill-routed task ${task.id.slice(0,8)} → ${target.session_id.slice(0,8)} (${skill})\n`)
      return { jsonrpc: '2.0', id, result: { task } }
    }

    // Broadcast to all MCP sessions
    const msgId = `m${Date.now()}-${++seq}`
    broadcastNotification('notifications/message', {
      content: text,
      meta: { message_id: msgId, ts: new Date().toISOString(), event: 'a2a_broadcast', message },
    })
    const task = createTask('broadcast', message)
    updateTask(task.id, { status: { state: 'completed' }, result: { message_id: msgId } })
    process.stderr.write(`[switchboard] A2A broadcast ${msgId}\n`)
    return { jsonrpc: '2.0', id, result: { task } }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}

// ---------------------------------------------------------------------------
// MCP session management
// ---------------------------------------------------------------------------

const mcpSessions = new Map()

export function broadcastNotification(method, params) {
  for (const [, { server }] of mcpSessions) {
    try { server.notification({ method, params }) } catch {}
  }
}

function createMcpServer() {
  const server = new Server(
    { name: 'calling-all-stations', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: `Calling-all-stations is a multi-agent coordination server supporting MCP and A2A.

When you receive a <channel source="calling-all-stations"> notification:
- event="agent_status": log the update; the sending agent changed step.
- event="agent_question": an agent needs an answer. Call send_directive with type="answer" immediately.
- event="agent_response": an A2A task was completed by an agent. Mark the task done.
- event="issue_complete": an agent finished its task.
- event="a2a_broadcast": an external A2A agent sent a broadcast message.
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
        description: 'Send a directive to another registered agent. The message lands in their inbox on their next check_inbox call.',
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
        description: 'Broadcast a status update or question to all connected MCP sessions.',
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
      {
        name: 'complete_task',
        description: 'Complete or fail an A2A task that was routed to you via check_inbox (type: a2a_message). Call this when you have finished processing the task.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id:   { type: 'string', description: 'The task_id from the a2a_message directive body' },
            result:    { type: 'object', description: 'Task result payload (omit or null to indicate failure)' },
            error:     { type: 'object', description: 'Error details if the task failed. Sets state to "failed".' },
            artifacts: {
              type: 'array',
              description: 'Optional output artifacts (A2A spec: { artifactId, name, description, parts[] })',
              items: {
                type: 'object',
                properties: {
                  artifactId:  { type: 'string' },
                  name:        { type: 'string' },
                  description: { type: 'string' },
                  parts:       { type: 'array' },
                },
              },
            },
          },
          required: ['task_id'],
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
      const msgId = `m${Date.now()}-${++seq}`
      const content = message ?? question ?? `${eventType}:${session_id}`
      broadcastNotification('notifications/message', {
        content,
        meta: {
          message_id: msgId, ts: new Date().toISOString(),
          event: eventType, session_id,
          question: question ?? null, blocking: blocking ?? false, step: step ?? null,
        },
      })
      process.stderr.write(`[switchboard] send event=${eventType} session=${session_id.slice(0,8)}\n`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: msgId }) }] }
    }

    if (name === 'complete_task') {
      const { task_id, result, error: taskError, artifacts = [] } = args
      const task = getTask(task_id)
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'task_not_found' }) }] }
      }
      const newState = taskError ? 'failed' : 'completed'
      updateTask(task_id, {
        status: taskError ? { state: 'failed', error: taskError } : { state: 'completed' },
        result: result ?? null,
        artifacts,
      })
      process.stderr.write(`[switchboard] task ${newState}: ${task_id.slice(0,8)}\n`)
      broadcastNotification('notifications/message', {
        content: `Task ${task_id.slice(0,8)} ${newState}`,
        meta: { message_id: `m${Date.now()}`, ts: new Date().toISOString(), event: 'agent_response', task_id, result, state: newState },
      })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task_id, state: newState }) }] }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown tool' }) }], isError: true }
  })

  return server
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function createAppServer() {
  const httpServer = createServer(async (req, res) => {

    // MCP Streamable HTTP
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

    // A2A coordinator endpoint
    if (req.url === '/a2a') {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        await new Promise(r => req.on('end', r))
        let payload
        try { payload = JSON.parse(body) } catch {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }

        // sendStreamingMessage / message/stream — SSE streaming response
        if (payload.method === 'message/stream' || payload.method === 'sendStreamingMessage') {
          const { id, params } = payload
          const message = params?.message
          if (!message) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing message' } }))
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          })

          const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`)
          }

          // Emit working status immediately
          const taskId = crypto.randomUUID()
          sendEvent({ jsonrpc: '2.0', id, result: { task: { id: taskId, status: { state: 'working' } } } })

          // Broadcast and stream the result
          const skill = params?.skill
          const text = Array.isArray(message.parts)
            ? extractTextFromParts(message.parts)
            : (message.text ?? JSON.stringify(message))
          const msgId = `m${Date.now()}-${++seq}`
          broadcastNotification('notifications/message', {
            content: text,
            meta: { message_id: msgId, ts: new Date().toISOString(), event: 'a2a_stream', task_id: taskId },
          })
          process.stderr.write(`[switchboard] A2A stream ${taskId.slice(0,8)}\n`)

          // Emit completion
          setTimeout(() => {
            sendEvent({
              jsonrpc: '2.0', id,
              result: { task: { id: taskId, status: { state: 'completed' }, result: { message_id: msgId } } },
            })
            res.end()
          }, 100)
          return
        }

        const result = handleA2aRequest(payload, null, getServerUrl(), { a2aVersion: req.headers['a2a-version'] })
        res.writeHead(200, { 'content-type': 'application/json', 'a2a-version': '1.0' })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(405); res.end('Method Not Allowed')
      return
    }

    // A2A per-agent proxy endpoint
    const agentA2aMatch = req.url.match(/^\/agents\/([^/]+)\/a2a$/)
    if (agentA2aMatch) {
      if (req.method === 'POST') {
        const session_id = agentA2aMatch[1]
        let body = ''
        req.on('data', c => { body += c })
        await new Promise(r => req.on('end', r))
        let payload
        try { payload = JSON.parse(body) } catch {
          res.writeHead(200, { 'content-type': 'application/json', 'a2a-version': '1.0' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }
        const result = handleA2aRequest(payload, session_id, getServerUrl(), { a2aVersion: req.headers['a2a-version'] })
        res.writeHead(200, { 'content-type': 'application/json', 'a2a-version': '1.0' })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(405); res.end('Method Not Allowed')
      return
    }

    // A2A agent card — coordinator
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildCoordinatorCard(), null, 2))
      return
    }

    // A2A agent directory
    if (req.method === 'GET' && req.url === '/agents/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildAgentDirectory(), null, 2))
      return
    }

    // A2A per-agent card
    const agentCardMatch = req.url.match(/^\/agents\/([^/]+)\/agent-card\.json$/)
    if (req.method === 'GET' && agentCardMatch) {
      const session_id = agentCardMatch[1]
      const card = buildAgentCard(session_id)
      if (!card) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(card, null, 2))
      return
    }

    // Health
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', port: PORT, agents: registry.size, mcp_sessions: mcpSessions.size, tasks: tasks.size }))
      return
    }

    // Registry
    if (req.method === 'GET' && req.url === '/registry') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ agents: Object.fromEntries(registry) }))
      return
    }

    // Skills directory
    if (req.method === 'GET' && req.url === '/skills') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildSkillDirectory(), null, 2))
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405); res.end('Method Not Allowed'); return
    }

    // --- POST endpoints ---
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload
      try { payload = JSON.parse(body) } catch { payload = { message: body.trim() } }

      if (req.url === '/register') {
        const { session_id, issue_number, label, started_at, skills } = payload
        if (session_id) {
          registry.set(session_id, {
            session_id,
            issue_number: issue_number ?? null,
            label: label ?? 'registered',
            started_at: started_at ?? new Date().toISOString(),
            status: 'running',
            last_status_at: new Date().toISOString(),
            current_step: 'starting',
            skills: Array.isArray(skills) ? skills : [],
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
        const { event: eventType, session_id, message, question, blocking, step, task_id, result, artifacts } = payload
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
        // agent_response: complete the referenced A2A task
        if (eventType === 'agent_response' && task_id) {
          const task = getTask(task_id)
          if (task) {
            updateTask(task_id, {
              status: { state: 'completed' },
              result: result ?? { message },
              artifacts: Array.isArray(artifacts) ? artifacts : [],
            })
            process.stderr.write(`[switchboard] HTTP agent_response completed task ${task_id.slice(0,8)}\n`)
          }
        }
        const msgId = `m${Date.now()}-${++seq}`
        const content = message ?? question ?? `${eventType}:${session_id}`
        broadcastNotification('notifications/message', {
          content,
          meta: {
            message_id: msgId, ts: new Date().toISOString(),
            event: eventType, session_id,
            question: question ?? null, blocking: blocking ?? false, step: step ?? null,
            task_id: task_id ?? null,
          },
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message_id: msgId }))
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
      const msgId = `m${Date.now()}-${++seq}`
      const content = payload.message ?? JSON.stringify(payload)
      broadcastNotification('notifications/message', {
        content,
        meta: { message_id: msgId, ts: new Date().toISOString(), event: payload.event ?? 'message', ...payload },
      })
      res.writeHead(204); res.end()
      process.stderr.write(`[switchboard] broadcast: ${content.slice(0, 120)}\n`)
    })
  })

  return httpServer
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Only start listening when run directly (not imported by tests)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  hydrateState()
  setInterval(persistState, 30_000)
  setInterval(pruneExpiredTasks, 5 * 60 * 1000)

  const httpServer = createAppServer()
  httpServer.listen(PORT, BIND_HOST, () => {
    process.stderr.write(`[switchboard] v1.1.0 listening on ${BIND_HOST}:${PORT}\n`)
    process.stderr.write(`[switchboard] MCP at /mcp | A2A at /a2a | Cards at /.well-known/agent-card.json\n`)
  })
}
