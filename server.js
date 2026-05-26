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
 *   STATE_FILE  — persistence JSON path (default: ./calling-all-stations-state.json)
 *   SERVER_URL  — public base URL for agent cards (default: http://localhost:PORT)
 */

import { Server }                        from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer }                  from 'node:http'
import { fileURLToPath }                 from 'node:url'
import fs                                from 'node:fs'
import path                              from 'node:path'
import crypto                            from 'node:crypto'

// ============================================================================
// OBSERVABILITY (verbose-debug mode — stays on until we hit 7 days stable)
// ============================================================================
const __dir_obs = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = path.join(__dir_obs, 'server.log')
const LOG_MAX_BYTES = 10 * 1024 * 1024  // 10 MB before rotate
const LOG_KEEP = 5
let __log_stream = null
function _openLog() {
  try { __log_stream = fs.createWriteStream(LOG_FILE, { flags: 'a' }) } catch (e) {}
}
_openLog()
function _maybeRotate() {
  try {
    const s = fs.statSync(LOG_FILE)
    if (s.size < LOG_MAX_BYTES) return
    try { __log_stream && __log_stream.end() } catch {}
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`, to = `${LOG_FILE}.${i+1}`
      if (fs.existsSync(from)) { try { fs.renameSync(from, to) } catch {} }
    }
    try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch {}
    _openLog()
  } catch (e) {}
}
setInterval(_maybeRotate, 60_000)
// Single structured logger — writes to BOTH stderr (for schtask capture if redirected) AND file
export function dlog(level, scope, ...args) {
  const ts = new Date().toISOString()
  const msg = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ')
  const line = `${ts} [${level}] [${scope}] ${msg}\n`
  try { process.stderr.write(line) } catch {}
  try { __log_stream && __log_stream.write(line) } catch {}
}
// Counters for /metrics endpoint
export const counters = {
  startup_ts: new Date().toISOString(),
  http_requests: 0,
  http_errors: 0,
  mcp_tool_calls: {},
  wakeups_attempted: 0,
  wakeups_succeeded: 0,
  wakeups_timed_out: 0,
  wakeups_errored: 0,
  directives_sent: 0,
  inbox_checks: 0,
  registry_size: 0,
  state_persists: 0,
  uncaught_exceptions: 0,
  unhandled_rejections: 0,
}
dlog('INFO', 'observability', 'log file', LOG_FILE)

export const PORT       = Number(process.env.PORT ?? 8788)
export const BIND_HOST  = process.env.BIND_HOST ?? '0.0.0.0'
export const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'calling-all-stations-state.json')

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

// Persona-scoped event queues for HTTP long-poll / streaming delivery.
// Keyed by persona name (e.g. 'wolf'), independent of MCP transport lifecycle.
export const personaQueues   = new Map()  // persona -> [{ id, body, ts }]
export const personaWaiters  = new Map()  // persona -> [resolveFn]
export const personaLastPoll = new Map()  // persona -> ISO timestamp of last stream connect
const PERSONA_QUEUE_MAX = 50
const PERSONA_QUEUE_TTL_MS = 10 * 60 * 1000

export function enqueuePersonaEvent(persona, event) {
  if (!persona) return null
  if (!personaQueues.has(persona)) personaQueues.set(persona, [])
  const q = personaQueues.get(persona)
  const cutoff = Date.now() - PERSONA_QUEUE_TTL_MS
  while (q.length && Date.parse(q[0].ts) < cutoff) q.shift()
  const item = { id: crypto.randomUUID(), body: event, ts: new Date().toISOString() }
  q.push(item)
  while (q.length > PERSONA_QUEUE_MAX) q.shift()
  const waiters = personaWaiters.get(persona) || []
  personaWaiters.set(persona, [])
  for (const w of waiters) { try { w(item) } catch {} }
  return item
}

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
    process.stderr.write(`[calling-all-stations] persistState error: ${e.message}\n`)
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
    process.stderr.write(`[calling-all-stations] Hydrated ${registry.size} sessions from state\n`)
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
    process.stderr.write(`[calling-all-stations] auto-registered ${session_id.slice(0,8)} via ${via}\n`)
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
    provider: {
      name: 'calling-all-stations',
      url: base,
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    securitySchemes: {},
    security: [],
    interfaces: [
      { transport: 'http', url: `${base}/a2a` },
      { transport: 'mcp', url: `${base}/mcp`, description: 'MCP Streamable HTTP (Claude / MCP agents)' },
    ],
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
    provider: {
      name: 'calling-all-stations',
      url: base,
    },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {},
    security: [],
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

export const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected'])

// Valid state transitions per A2A v1.0 spec
export const VALID_TRANSITIONS = {
  submitted:      new Set(['working', 'completed', 'rejected', 'canceled', 'auth_required']),
  working:        new Set(['completed', 'failed', 'canceled', 'input_required', 'rejected']),
  input_required: new Set(['working', 'canceled', 'failed', 'rejected']),
  auth_required:  new Set(['working', 'canceled', 'failed', 'rejected']),
  completed:      new Set(),
  failed:         new Set(),
  canceled:       new Set(),
  rejected:       new Set(),
}

export function isValidTransition(fromState, toState) {
  return VALID_TRANSITIONS[fromState]?.has(toState) ?? false
}

/** Normalize message parts in-place for spec compliance before storage. */
function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return message
  if (!Array.isArray(message.parts)) return message
  return { ...message, parts: message.parts.map(normalizePart).filter(Boolean) }
}

export function createTask(sessionId, message, contextId = null, metadata = null, extensions = null) {
  const id = crypto.randomUUID()
  const task = {
    id,
    contextId: contextId ?? crypto.randomUUID(),
    session_id: sessionId,
    status: { state: 'submitted' },
    message: normalizeMessage(message),
    result: null,
    artifacts: [],
    ...(metadata   ? { metadata }   : {}),
    ...(extensions ? { extensions } : {}),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  tasks.set(id, task)
  return task
}

export function updateTask(taskId, patch) {
  const task = tasks.get(taskId)
  if (!task) return null
  // Validate state transition if state is changing
  if (patch.status?.state && patch.status.state !== task.status.state) {
    if (!isValidTransition(task.status.state, patch.status.state)) {
      process.stderr.write(`[calling-all-stations] invalid transition ${task.status.state} → ${patch.status.state} for task ${taskId.slice(0,8)}\n`)
      return { error: `invalid_transition:${task.status.state}→${patch.status.state}`, task }
    }
  }
  // Normalize artifacts if provided
  if (Array.isArray(patch.artifacts)) {
    patch = { ...patch, artifacts: patch.artifacts.map(normalizeArtifact).filter(Boolean) }
  }
  Object.assign(task, patch, { updated_at: new Date().toISOString() })
  // Push to any SSE subscribers watching this task
  notifyTaskSubscribers(taskId)
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
// Task subscription — per-task SSE push (subscribeToTask)
// ---------------------------------------------------------------------------

// taskId → Set of { res, id } (one per subscriber)
export const taskSubscribers = new Map()

export function notifyTaskSubscribers(taskId) {
  const subs = taskSubscribers.get(taskId)
  if (!subs || subs.size === 0) return
  const task = getTask(taskId)
  if (!task) return
  const event = JSON.stringify({ jsonrpc: '2.0', id: null, result: { task } })
  for (const sub of subs) {
    try { sub.res.write(`data: ${event}\n\n`) } catch {}
  }
  // If task reached terminal state, close all subscriber streams
  if (TERMINAL_STATES.has(task.status.state)) {
    for (const sub of subs) {
      try { sub.res.end() } catch {}
    }
    taskSubscribers.delete(taskId)
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
    if (TERMINAL_STATES.has(task.status.state)) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `Task already in terminal state: ${task.status.state}` } }
    }
    updateTask(taskId, { status: { state: 'canceled' } })
    process.stderr.write(`[calling-all-stations] A2A task ${taskId.slice(0,8)} canceled\n`)
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

  if (method === 'getExtendedAgentCard') {
    // Returns the full coordinator card (same as /.well-known/agent-card.json for now).
    // In authenticated contexts this could include private skill details or rate limits.
    return { jsonrpc: '2.0', id, result: { agentCard: buildCoordinatorCard() } }
  }

  if (method === 'subscribeToTask') {
    // subscribeToTask is SSE-based — cannot be handled in the pure JSON-RPC function.
    // Return a sentinel so the HTTP layer can set up the SSE stream.
    const taskId = params?.taskId ?? params?.id
    if (!taskId) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing taskId' } }
    }
    const task = getTask(taskId)
    if (!task) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } }
    }
    return { jsonrpc: '2.0', id, result: { task }, _subscribe: taskId }
  }

  if (method === 'rejectTask') {
    const taskId = params?.taskId ?? params?.id
    const reason = params?.reason ?? 'Agent rejected task'
    if (!taskId) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing taskId' } }
    }
    const task = getTask(taskId)
    if (!task) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } }
    }
    if (TERMINAL_STATES.has(task.status.state)) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `Task already in terminal state: ${task.status.state}` } }
    }
    updateTask(taskId, { status: { state: 'rejected', reason } })
    process.stderr.write(`[calling-all-stations] A2A task ${taskId.slice(0,8)} rejected: ${reason}\n`)
    return { jsonrpc: '2.0', id, result: { task: getTask(taskId) } }
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
      const returnImmediately = params?.returnImmediately !== false // default true for non-blocking
      const task = createTask(sessionId, message, params?.contextId ?? null, params?.metadata ?? null, params?.extensions ?? null)
      const directive = {
        id: crypto.randomUUID(),
        type: 'a2a_message',
        body: { task_id: task.id, message, returnImmediately },
        sent_at: new Date().toISOString(),
        delivered: false,
      }
      if (!inboxes.has(sessionId)) inboxes.set(sessionId, [])
      inboxes.get(sessionId).push(directive)
      updateTask(task.id, { status: { state: 'working' } })
      persistState()
      process.stderr.write(`[calling-all-stations] A2A task ${task.id.slice(0,8)} queued for agent ${sessionId.slice(0,8)}\n`)
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
      const task = createTask(target.session_id, message, params?.contextId ?? null, params?.metadata ?? null, params?.extensions ?? null)
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
      process.stderr.write(`[calling-all-stations] A2A skill-routed task ${task.id.slice(0,8)} → ${target.session_id.slice(0,8)} (${skill})\n`)
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
    process.stderr.write(`[calling-all-stations] A2A broadcast ${msgId}\n`)
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
    // server.notification() is async and rejects if the MCP client has disconnected.
    // The .catch() is required — an unhandled rejection here crashes the process.
    try { server.notification({ method, params }).catch(() => {}) } catch {}
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
            task_id:    { type: 'string', description: 'Active task ID — if provided with agent_question+blocking, task moves to input_required state' },
          },
          required: ['event', 'session_id'],
        },
      },
      {
        name: 'reject_task',
        description: 'Reject an A2A task that was routed to you — use when the task is outside your capabilities or you cannot process it.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task_id from the a2a_message directive body' },
            reason:  { type: 'string', description: 'Human-readable reason for rejection' },
          },
          required: ['task_id'],
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
      process.stderr.write(`[calling-all-stations] check_inbox ${session_id.slice(0,8)}: ${pending.length} directive(s)\n`)
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
      const entry = registry.get(session_id)
      if (type === 'answer' && entry) {
        entry.waiting_for_answer = false
        entry.last_status_at = new Date().toISOString()
        // Resume any input_required task for this agent back to working
        for (const task of tasks.values()) {
          if (task.session_id === session_id && task.status.state === 'input_required') {
            updateTask(task.id, { status: { state: 'working' } })
            break
          }
        }
      }
      persistState()
      process.stderr.write(`[calling-all-stations] directive -> ${session_id.slice(0,8)}: ${type}\n`)
      // Wake-up dispatch: if target is wakeup_only with a wakeup_url, POST the directive so
      // the remote hook-agent fires immediately instead of waiting for a check_inbox poll
      // that will never come. Fire-and-forget; client already has its directive_id.
      // We coerce the directive body to a plain string before posting, because remote
      // hook-agents (e.g. mike-hook-agent.js) do `${directive}` string interpolation —
      // an unstringified object becomes "[object Object]". Prefer .message > .task >
      // .instruction > JSON.stringify(whole body).
      if (entry && entry.wakeup_url && entry.kind === 'wakeup_only') {
        counters.wakeups_attempted++; counters.directives_sent++
        dlog('DEBUG', 'wakeup-mcp', { target: session_id.slice(0,8), url: entry.wakeup_url, type })
        const directiveText = typeof body === 'string'
          ? body
          : (body && (body.message || body.task || body.instruction)) || JSON.stringify(body)
        import('http').then(http => {
          try {
            const u = new URL(entry.wakeup_url)
            const payload = JSON.stringify({ body: directiveText, directive_id: directive.id, type, from: 'send_directive', meta: typeof body === 'object' ? body : null })
            const req2 = http.request({
              hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),
              method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
              timeout: 5000
            }, (resp) => { resp.resume(); counters.wakeups_succeeded++; dlog('DEBUG','wakeup-mcp',{target:session_id.slice(0,8),status:resp.statusCode}) })
            req2.on('timeout', () => {
              counters.wakeups_timed_out++
              dlog('WARN','wakeup-mcp', `TIMEOUT target=${session_id.slice(0,8)} url=${entry.wakeup_url}`)
              req2.destroy(new Error('wakeup timeout'))
            })
            req2.on('error', e => { counters.wakeups_errored++; dlog('ERROR','wakeup-mcp',`target=${session_id.slice(0,8)} err=${e.message}`) })
            req2.write(payload); req2.end()
          } catch (e) {
            process.stderr.write(`[calling-all-stations] directive wakeup dispatch failed: ${e.message}\n`)
          }
        })
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, directive_id: directive.id }) }] }
    }

    if (name === 'send') {
      const { event: eventType, session_id, message, question, blocking, step, task_id } = args
      autoRegister(session_id, `MCP send(${eventType})`)
      const entry = registry.get(session_id)
      if (entry) {
        if (step) { entry.current_step = step; entry.last_status_at = new Date().toISOString() }
        if (eventType === 'agent_question' && blocking) {
          entry.waiting_for_answer = true
          entry.question    = question ?? null
          entry.question_at = new Date().toISOString()
          // Transition active task to input_required if task_id provided
          if (task_id) {
            const t = getTask(task_id)
            if (t && !TERMINAL_STATES.has(t.status.state)) {
              updateTask(task_id, { status: { state: 'input_required', question: question ?? null } })
            }
          }
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
      process.stderr.write(`[calling-all-stations] send event=${eventType} session=${session_id.slice(0,8)}\n`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: msgId }) }] }
    }

    if (name === 'reject_task') {
      const { task_id, reason = 'Agent rejected task' } = args
      const task = getTask(task_id)
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'task_not_found' }) }] }
      }
      if (TERMINAL_STATES.has(task.status.state)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `already_terminal:${task.status.state}` }) }] }
      }
      updateTask(task_id, { status: { state: 'rejected', reason } })
      process.stderr.write(`[calling-all-stations] task rejected: ${task_id.slice(0,8)}\n`)
      broadcastNotification('notifications/message', {
        content: `Task ${task_id.slice(0,8)} rejected`,
        meta: { message_id: `m${Date.now()}`, ts: new Date().toISOString(), event: 'agent_response', task_id, state: 'rejected', reason },
      })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task_id, state: 'rejected' }) }] }
    }

    if (name === 'complete_task') {
      const { task_id, result, error: taskError, artifacts = [] } = args
      const task = getTask(task_id)
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'task_not_found' }) }] }
      }
      const newState = taskError ? 'failed' : 'completed'
      const updated = updateTask(task_id, {
        status: taskError ? { state: 'failed', error: taskError } : { state: 'completed' },
        result: result ?? null,
        artifacts,
      })
      if (updated?.error) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: updated.error }) }] }
      }
      process.stderr.write(`[calling-all-stations] task ${newState}: ${task_id.slice(0,8)}\n`)
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
    // Request-level observability — every HTTP request logged with method, url, status, latency
    const __req_start = Date.now()
    const __req_method = req.method
    const __req_url = req.url
    counters.http_requests++
    res.once('finish', () => {
      const dur = Date.now() - __req_start
      if (res.statusCode >= 400) counters.http_errors++
      const level = res.statusCode >= 500 ? 'ERROR' : (res.statusCode >= 400 ? 'WARN' : 'DEBUG')
      dlog(level, 'http', `${__req_method} ${__req_url} ${res.statusCode} ${dur}ms`)
    })

    // /metrics — counter snapshot for observability + alerting
    if (req.method === 'GET' && req.url === '/metrics') {
      counters.registry_size = registry.size
      const mem = process.memoryUsage()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ...counters,
        uptime_s: Math.round(process.uptime()),
        inboxes: inboxes.size,
        tasks: tasks.size,
        mcp_sessions: mcpSessions.size,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        now: new Date().toISOString(),
      }, null, 2))
      return
    }

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
              // KEEPALIVE: send a heartbeat notification every 25s so the SSE/HTTP
              // streaming connection doesn't go idle long enough for proxies / kernel
              // TCP keepalive / Claude Code MCP harness to mark it dropped. Cleared on close.
              const heartbeat = setInterval(async () => {
                try {
                  await mcpServer.notification({
                    method: 'notifications/message',
                    params: {
                      level: 'debug',
                      logger: 'keepalive',
                      data: { ts: new Date().toISOString(), session: sid.slice(0,8) }
                    }
                  })
                  counters.mcp_keepalives_sent = (counters.mcp_keepalives_sent || 0) + 1
                } catch (e) {
                  // Transport closed under us — log + clear, onclose handles the rest
                  counters.mcp_keepalives_failed = (counters.mcp_keepalives_failed || 0) + 1
                  dlog('DEBUG', 'mcp-keepalive', `session=${sid.slice(0,8)} err=${e.message}`)
                  clearInterval(heartbeat)
                }
              }, 25_000)
              mcpSessions.set(sid, { transport, server: mcpServer, heartbeat })
              dlog('INFO', 'mcp', `session init ${sid.slice(0,8)} (total=${mcpSessions.size}, keepalive=25s)`)
            },
          })
          let mcpServer
          transport.onclose = () => {
            const sid = transport.sessionId
            if (sid) {
              const sess = mcpSessions.get(sid)
              if (sess?.heartbeat) clearInterval(sess.heartbeat)
              mcpSessions.delete(sid)
              dlog('INFO', 'mcp', `session closed ${sid.slice(0,8)} (total=${mcpSessions.size})`)
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
          process.stderr.write(`[calling-all-stations] A2A stream ${taskId.slice(0,8)}\n`)

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

        // subscribeToTask: upgrade to SSE and stream task updates
        if (result._subscribe) {
          const taskId = result._subscribe
          delete result._subscribe
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'a2a-version': '1.0',
          })
          // Send current task state immediately
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: result.id, result: result.result })}\n\n`)
          const sub = { res, id: result.id }
          if (!taskSubscribers.has(taskId)) taskSubscribers.set(taskId, new Set())
          taskSubscribers.get(taskId).add(sub)
          req.on('close', () => {
            taskSubscribers.get(taskId)?.delete(sub)
          })
          return
        }

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

        // sendStreamingMessage on per-agent endpoint — SSE stream routed to specific agent
        if (payload.method === 'message/stream' || payload.method === 'sendStreamingMessage') {
          const { id, params } = payload
          const message = params?.message
          if (!message) {
            res.writeHead(200, { 'content-type': 'application/json', 'a2a-version': '1.0' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing message' } }))
            return
          }
          if (!registry.has(session_id)) {
            res.writeHead(200, { 'content-type': 'application/json', 'a2a-version': '1.0' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Agent not found' } }))
            return
          }
          // Create the task and route directive as normal, then stream updates
          const task = createTask(session_id, message, params?.contextId ?? null)
          const directive = {
            id: crypto.randomUUID(), type: 'a2a_message',
            body: { task_id: task.id, message, returnImmediately: params?.returnImmediately !== false },
            sent_at: new Date().toISOString(), delivered: false,
          }
          if (!inboxes.has(session_id)) inboxes.set(session_id, [])
          inboxes.get(session_id).push(directive)
          updateTask(task.id, { status: { state: 'working' } })
          persistState()

          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'a2a-version': '1.0',
          })
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { task: getTask(task.id) } })}\n\n`)
          const sub = { res, id }
          if (!taskSubscribers.has(task.id)) taskSubscribers.set(task.id, new Set())
          taskSubscribers.get(task.id).add(sub)
          req.on('close', () => { taskSubscribers.get(task.id)?.delete(sub) })
          process.stderr.write(`[calling-all-stations] A2A per-agent stream task ${task.id.slice(0,8)} → ${session_id.slice(0,8)}\n`)
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

    // DELETE /deregister/:session_id
    if (req.method === 'DELETE' && req.url.startsWith('/deregister/')) {
      const session_id = req.url.slice('/deregister/'.length)
      registry.delete(session_id)
      inboxes.delete(session_id)
      persistState()
      process.stderr.write(`[calling-all-stations] deregistered ${session_id.slice(0,8)}\n`)
      res.writeHead(204); res.end(); return
    }

    // Persona event stream (HTTP chunked NDJSON, one JSON line per event).
    // Intended for Monitor / curl -N consumers. Survives MCP reconnects.
    // GET /inbox/:persona/stream — holds open until client disconnects.
    if (req.method === 'GET' && req.url.startsWith('/inbox/') && req.url.endsWith('/stream')) {
      const persona = req.url.slice('/inbox/'.length, -'/stream'.length)
      if (!persona) { res.writeHead(400); res.end('persona required'); return }
      personaLastPoll.set(persona, new Date().toISOString())
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const backlog = personaQueues.get(persona) || []
      for (const item of backlog) {
        res.write(JSON.stringify({ id: item.id, ts: item.ts, ...item.body }) + '\n')
      }
      personaQueues.set(persona, [])
      const subscribe = () => {
        const arr = personaWaiters.get(persona) || []
        arr.push(item => {
          try {
            res.write(JSON.stringify({ id: item.id, ts: item.ts, ...item.body }) + '\n')
            personaLastPoll.set(persona, new Date().toISOString())
          } catch {}
          subscribe()
        })
        personaWaiters.set(persona, arr)
      }
      subscribe()
      const heartbeat = setInterval(() => {
        try {
          res.write(JSON.stringify({ event: 'keepalive', ts: new Date().toISOString() }) + '\n')
          personaLastPoll.set(persona, new Date().toISOString())
        } catch {}
      }, 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        process.stderr.write(`[calling-all-stations] /inbox/${persona}/stream disconnected\n`)
      })
      process.stderr.write(`[calling-all-stations] /inbox/${persona}/stream connected\n`)
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
        const { session_id, issue_number, label, started_at, skills, persona, wakeup_url, kind } = payload
        if (session_id) {
          const existing = registry.get(session_id) ?? {}
          // kind: 'wakeup_only' means this is a persona-placeholder entry holding a wakeup URL.
          // It is NOT an active subscribed session — dispatcher should fall through to the wakeup path.
          const isWakeupOnly = kind === 'wakeup_only'
          registry.set(session_id, {
            session_id,
            issue_number: issue_number ?? existing.issue_number ?? null,
            label: label ?? existing.label ?? 'registered',
            started_at: started_at ?? existing.started_at ?? new Date().toISOString(),
            status: isWakeupOnly ? 'wakeup_only' : 'running',
            last_status_at: new Date().toISOString(),
            current_step: isWakeupOnly ? 'idle' : 'starting',
            skills: Array.isArray(skills) ? skills : (existing.skills ?? []),
            persona: persona ?? existing.persona ?? null,
            wakeup_url: wakeup_url ?? existing.wakeup_url ?? null,
            kind: kind ?? existing.kind ?? null,
          })
          inboxes.set(session_id, inboxes.get(session_id) ?? [])
          persistState()
          process.stderr.write(`[calling-all-stations] registered ${session_id.slice(0,8)} persona=${persona ?? '-'} wakeup=${wakeup_url ?? '-'} kind=${kind ?? '-'}\n`)
        }
        res.writeHead(204); res.end(); return
      }

      if (req.url.startsWith('/deregister/')) {
        const session_id = req.url.replace('/deregister/', '')
        registry.delete(session_id)
        inboxes.delete(session_id)
        persistState()
        process.stderr.write(`[calling-all-stations] deregistered ${session_id.slice(0,8)}\n`)
        res.writeHead(204); res.end(); return
      }

      if (req.url === '/check-inbox' || req.url === '/check_inbox') {
        // Accept canonical {session_id} or natural {to} / {persona}. Resolve persona
        // shortcut (e.g. "mike") to <persona>-persistent so remote agents can poll
        // their own inbox using their own name.
        let session_id = payload.session_id || payload.to || payload.persona
        if (session_id && !registry.has(session_id)) {
          const persistent = `${session_id}-persistent`
          if (registry.has(persistent)) {
            session_id = persistent
          } else {
            for (const [sid, entry] of registry.entries()) {
              if (entry.persona === session_id && entry.kind === 'wakeup_only') { session_id = sid; break }
            }
          }
        }
        if (!session_id) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'missing session_id (or to/persona)' })); return
        }
        autoRegister(session_id, 'HTTP /check-inbox')
        const pending = (inboxes.get(session_id) ?? []).filter(d => !d.delivered)
        for (const d of pending) d.delivered = true
        process.stderr.write(`[calling-all-stations] HTTP check-inbox ${session_id.slice(0,8)}: ${pending.length} directive(s)\n`)
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
            // Transition active task to input_required
            if (task_id) {
              const t = getTask(task_id)
              if (t && !TERMINAL_STATES.has(t.status.state)) {
                updateTask(task_id, { status: { state: 'input_required', question: question ?? null } })
              }
            }
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
            process.stderr.write(`[calling-all-stations] HTTP agent_response completed task ${task_id.slice(0,8)}\n`)
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
        process.stderr.write(`[calling-all-stations] HTTP send event=${eventType} session=${session_id?.slice(0,8)}\n`)
        return
      }

      if (req.url === '/send-directive' || req.url === '/send_directive') {
        // Accept both the canonical {session_id, type, body} and the more natural
        // {to, type, text|message|body, from} shape that remote agents tend to guess.
        let session_id = payload.session_id || payload.to
        const type = payload.type || 'message'
        let directiveBody = payload.body
        if (!directiveBody) {
          if (payload.text || payload.message) {
            directiveBody = { from: payload.from || 'unknown', message: payload.text || payload.message }
          }
        }
        if (!session_id || !directiveBody) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'missing session_id (or to), and body (or text/message)' })); return
        }
        // Persona resolution: if session_id isn't found, try <persona>-persistent, then
        // look up by persona field. Remote agents tend to guess "wolf" / "mike" instead
        // of the full session id, and we should route them rather than 404.
        if (!registry.has(session_id)) {
          const personaCandidate = `${session_id}-persistent`
          if (registry.has(personaCandidate)) {
            session_id = personaCandidate
          } else {
            for (const [sid, entry] of registry.entries()) {
              if (entry.persona === session_id && entry.wakeup_url) { session_id = sid; break }
            }
          }
        }
        if (!registry.has(session_id)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'session_not_found' })); return
        }
        const directive = { id: crypto.randomUUID(), type, body: directiveBody, sent_at: new Date().toISOString(), delivered: false }
        if (!inboxes.has(session_id)) inboxes.set(session_id, [])
        inboxes.get(session_id).push(directive)
        const entry = registry.get(session_id)
        if (type === 'answer' && entry) {
          entry.waiting_for_answer = false
          entry.last_status_at = new Date().toISOString()
          // Resume any input_required task back to working
          for (const task of tasks.values()) {
            if (task.session_id === session_id && task.status.state === 'input_required') {
              updateTask(task.id, { status: { state: 'working' } })
              break
            }
          }
        }
        persistState()
        process.stderr.write(`[calling-all-stations] HTTP send-directive -> ${session_id.slice(0,8)}: ${type}\n`)
        // Wake-up dispatch (same as MCP send_directive path)
        if (entry && entry.wakeup_url && entry.kind === 'wakeup_only') {
          const directiveText = typeof directiveBody === 'string'
            ? directiveBody
            : (directiveBody && (directiveBody.message || directiveBody.task || directiveBody.instruction)) || JSON.stringify(directiveBody)
          import('http').then(http => {
            try {
              const u = new URL(entry.wakeup_url)
              const wakePayload = JSON.stringify({ body: directiveText, directive_id: directive.id, type, from: 'send_directive_http', meta: typeof directiveBody === 'object' ? directiveBody : null })
              const req2 = http.request({
                hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),
                method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wakePayload) },
                timeout: 5000
              }, (resp) => { resp.resume(); counters.wakeups_succeeded++; dlog('DEBUG','wakeup-http',{target:session_id.slice(0,8),status:resp.statusCode}) })
              req2.on('timeout', () => {
                counters.wakeups_timed_out++
                dlog('WARN','wakeup-http', `TIMEOUT target=${session_id.slice(0,8)} url=${entry.wakeup_url}`)
                req2.destroy(new Error('wakeup timeout'))
              })
              req2.on('error', e => { counters.wakeups_errored++; dlog('ERROR','wakeup-http',`target=${session_id.slice(0,8)} err=${e.message}`) })
              req2.write(wakePayload); req2.end()
              counters.wakeups_attempted++; counters.directives_sent++
              dlog('DEBUG','wakeup-http',{target:session_id.slice(0,8),url:entry.wakeup_url,type})
            } catch (e) {
              process.stderr.write(`[calling-all-stations] HTTP directive wakeup dispatch failed: ${e.message}\n`)
            }
          })
        }
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

      // Mattermost outgoing webhook receiver.
      // Mattermost POSTs here when a trigger word fires (e.g. "@wolf").
      // Two delivery paths:
      //   1) If the target persona has an active session in the registry → broadcast (push)
      //   2) Otherwise, if the persona has a registered wakeup_url → POST to it (wake-up)
      // Self-mention and bot-to-self loops are skipped at the persona level.
      if (req.url === '/mm-webhook') {
        // Mattermost sends application/x-www-form-urlencoded OR application/json
        let mm = payload
        if (typeof payload === 'object' && payload.text === undefined && body) {
          try {
            const params = new URLSearchParams(body)
            mm = Object.fromEntries(params)
          } catch (e) { mm = payload }
        }
        const triggerWord = (mm.trigger_word || '').toLowerCase()
        const userName = mm.user_name || 'unknown'
        const channelName = mm.channel_name || 'unknown'
        const text = mm.text || ''
        const postId = mm.post_id || ''
        const rootId = mm.root_id || mm.parent_id || ''
        const persona = triggerWord.startsWith('@') ? triggerWord.slice(1) : triggerWord

        // Self-mention loop guard: if the message came from the persona's own bot account, skip.
        if (userName.toLowerCase() === persona) {
          process.stderr.write(`[calling-all-stations] mm-webhook: skipping self-mention ${persona}\n`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, skipped: 'self_mention' })); return
        }

        process.stderr.write(`[calling-all-stations] mm-webhook: #${channelName} ${userName} -> @${persona}\n`)

        const mentionEvent = {
          event: 'mattermost_mention',
          persona,
          channel: channelName,
          from: userName,
          text,
          post_id: postId,
          root_id: rootId,
          ts: new Date().toISOString()
        }

        // Always enqueue to the persona-scoped queue. Any live HTTP stream
        // consumer (Monitor) will receive it immediately; otherwise it sits
        // in the bounded queue until the persona reconnects or TTL evicts.
        enqueuePersonaEvent(persona, mentionEvent)

        // If a live stream consumer has polled within the keepalive window,
        // skip the wakeup-spawn fallback entirely — the queue delivered it.
        const lastPoll = personaLastPoll.get(persona)
        const livePoller = lastPoll && (Date.now() - Date.parse(lastPoll)) < 60_000
        if (livePoller) {
          process.stderr.write(`[calling-all-stations] mm-webhook: enqueued to ${persona} (live stream, last_poll ${lastPoll})\n`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, delivered: 'stream_queue', persona })); return
        }

        // Path 1: find an active session for this persona, push to it
        let activeSession = null
        for (const entry of registry.values()) {
          if (entry.persona === persona && entry.status === 'running') {
            activeSession = entry; break
          }
        }

        if (activeSession) {
          // Drop a directive in the active session's inbox AND broadcast notification
          if (!inboxes.has(activeSession.session_id)) inboxes.set(activeSession.session_id, [])
          inboxes.get(activeSession.session_id).push({
            id: crypto.randomUUID(),
            type: 'mattermost_mention',
            body: mentionEvent,
            sent_at: new Date().toISOString(),
            delivered: false
          })
          broadcastNotification('notifications/message', {
            content: `<channel source="calling-all-stations">${JSON.stringify(mentionEvent)}</channel>`,
            meta: mentionEvent
          })
          persistState()
          process.stderr.write(`[calling-all-stations] mm-webhook: pushed to active session ${activeSession.session_id.slice(0,8)}\n`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, delivered: 'active_session', session: activeSession.session_id })); return
        }

        // Path 2: wake-up. Find a registered wakeup_url for this persona (could be on stale entries).
        let wakeupUrl = null
        for (const entry of registry.values()) {
          if (entry.persona === persona && entry.wakeup_url) {
            wakeupUrl = entry.wakeup_url; break
          }
        }

        if (wakeupUrl) {
          // Fire and forget POST to the persona's hook-agent.
          // We don't await — Mattermost just needs a 200 OK fast.
          import('http').then(http => {
            try {
              const u = new URL(wakeupUrl)
              const body = JSON.stringify(mentionEvent)
              const req2 = http.request({
                hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),
                method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
                timeout: 5000
              }, (resp) => { resp.resume() })
              req2.on('timeout', () => {
                process.stderr.write(`[calling-all-stations] mm-webhook wakeup TIMEOUT at ${wakeupUrl}\n`)
                req2.destroy(new Error('mm-webhook wakeup timeout'))
              })
              req2.on('error', e => process.stderr.write(`[calling-all-stations] wakeup error: ${e.message}\n`))
              req2.write(body); req2.end()
            } catch (e) {
              process.stderr.write(`[calling-all-stations] wakeup dispatch failed: ${e.message}\n`)
            }
          })
          process.stderr.write(`[calling-all-stations] mm-webhook: woke ${persona} at ${wakeupUrl}\n`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, delivered: 'wakeup', url: wakeupUrl })); return
        }

        // No active session AND no wakeup URL → log and accept (Mattermost still expects 200).
        process.stderr.write(`[calling-all-stations] mm-webhook: no delivery path for persona=${persona}\n`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, delivered: 'none', reason: 'no_active_session_no_wakeup_url', persona })); return
      }

      // Default: broadcast notification
      const msgId = `m${Date.now()}-${++seq}`
      const content = payload.message ?? JSON.stringify(payload)
      broadcastNotification('notifications/message', {
        content,
        meta: { message_id: msgId, ts: new Date().toISOString(), event: payload.event ?? 'message', ...payload },
      })
      res.writeHead(204); res.end()
      process.stderr.write(`[calling-all-stations] broadcast: ${content.slice(0, 120)}\n`)
    })
  })

  return httpServer
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Only start listening when run directly (not imported by tests).
// Uses fileURLToPath + path.resolve for Windows compatibility (argv[1] may be relative).
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  // ROBUSTNESS: never let a bad promise or sync throw bring the process down silently.
  process.on('uncaughtException', (err) => {
    counters.uncaught_exceptions++
    dlog('ERROR', 'process', 'UNCAUGHT EXCEPTION:', err.stack || err.message || String(err))
  })
  process.on('unhandledRejection', (reason) => {
    counters.unhandled_rejections++
    dlog('ERROR', 'process', 'UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : String(reason))
  })
  process.on('SIGTERM', () => { dlog('INFO', 'process', 'SIGTERM received, exiting'); process.exit(0) })
  process.on('SIGINT',  () => { dlog('INFO', 'process', 'SIGINT received, exiting');  process.exit(0) })

  hydrateState()
  dlog('INFO', 'state', 'hydrated', { registry: registry.size, inboxes: inboxes.size, tasks: tasks.size })
  setInterval(() => { try { persistState(); counters.state_persists++ } catch (e) { dlog('ERROR','state','persist failed',e.message) } }, 30_000)
  setInterval(pruneExpiredTasks, 5 * 60 * 1000)
  // Periodic self-stat heartbeat — every 30s we log a single structured line so we can
  // trace what the process looked like before any hang or restart.
  setInterval(() => {
    try {
      counters.registry_size = registry.size
      const mem = process.memoryUsage()
      dlog('STAT', 'self', {
        up_s: Math.round(process.uptime()),
        registry: registry.size,
        inboxes: inboxes.size,
        tasks: tasks.size,
        mcp_sessions: mcpSessions.size,
        http_requests: counters.http_requests,
        http_errors: counters.http_errors,
        wake_att: counters.wakeups_attempted,
        wake_ok: counters.wakeups_succeeded,
        wake_to: counters.wakeups_timed_out,
        wake_err: counters.wakeups_errored,
        unc_ex: counters.uncaught_exceptions,
        unh_rej: counters.unhandled_rejections,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      })
    } catch (e) { dlog('ERROR','self-stat','failed',e.message) }
  }, 30_000)

  const httpServer = createAppServer()
  httpServer.listen(PORT, BIND_HOST, () => {
    dlog('INFO', 'http', `v1.2.2 listening on ${BIND_HOST}:${PORT}`)
    dlog('INFO', 'http', 'MCP at /mcp | A2A at /a2a | Cards at /.well-known/agent-card.json | /metrics for counters')
  })
}
