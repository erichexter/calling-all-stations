/**
 * Unit tests — pure function coverage, no HTTP server needed.
 * Run: node --test test/unit.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  registry,
  inboxes,
  tasks,
  autoRegister,
  buildCoordinatorCard,
  buildAgentCard,
  buildAgentDirectory,
  buildSkillDirectory,
  createTask,
  updateTask,
  getTask,
  pruneExpiredTasks,
  handleA2aRequest,
  validateA2aVersion,
  SUPPORTED_A2A_VERSIONS,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  isValidTransition,
  normalizePart,
  normalizeArtifact,
  extractTextFromParts,
} from '../server.js'

// Reset state between tests
beforeEach(() => {
  registry.clear()
  inboxes.clear()
  tasks.clear()
  process.env.SERVER_URL = 'http://test.local'
})

afterEach(() => {
  delete process.env.SERVER_URL
})

// ---------------------------------------------------------------------------
describe('normalizePart', () => {
  test('passes through spec-compliant text part', () => {
    const part = { kind: 'text', text: 'hello' }
    assert.deepEqual(normalizePart(part), part)
  })

  test('passes through spec-compliant raw part', () => {
    const part = { kind: 'raw', raw: Buffer.from('abc').toString('base64'), mediaType: 'image/png' }
    assert.deepEqual(normalizePart(part), part)
  })

  test('upgrades legacy {text} to {kind:"text", text}', () => {
    const result = normalizePart({ text: 'hello' })
    assert.equal(result.kind, 'text')
    assert.equal(result.text, 'hello')
  })

  test('upgrades legacy {data} to {kind:"data", data}', () => {
    const result = normalizePart({ data: { foo: 1 }, mediaType: 'application/json' })
    assert.equal(result.kind, 'data')
    assert.deepEqual(result.data, { foo: 1 })
    assert.equal(result.mediaType, 'application/json')
  })

  test('upgrades legacy {url} to {kind:"url", url}', () => {
    const result = normalizePart({ url: 'https://example.com/file.pdf' })
    assert.equal(result.kind, 'url')
    assert.equal(result.url, 'https://example.com/file.pdf')
  })

  test('returns null for invalid input', () => {
    assert.equal(normalizePart(null), null)
    assert.equal(normalizePart('string'), null)
    assert.equal(normalizePart({}), null)
  })
})

// ---------------------------------------------------------------------------
describe('normalizeArtifact', () => {
  test('creates spec-compliant artifact with artifactId', () => {
    const art = normalizeArtifact({ name: 'report', description: 'A report', parts: [{ kind: 'text', text: 'body' }] })
    assert.ok(art.artifactId)
    assert.equal(art.name, 'report')
    assert.equal(art.parts[0].kind, 'text')
  })

  test('generates artifactId when missing', () => {
    const art = normalizeArtifact({ name: 'x', parts: [] })
    assert.ok(art.artifactId.length > 0)
  })

  test('upgrades legacy {data, mimeType} to parts', () => {
    const art = normalizeArtifact({ name: 'file', data: '<html>', mimeType: 'text/html' })
    assert.equal(art.parts.length, 1)
    assert.equal(art.parts[0].kind, 'data')
  })

  test('returns null for invalid input', () => {
    assert.equal(normalizeArtifact(null), null)
    assert.equal(normalizeArtifact('bad'), null)
  })
})

// ---------------------------------------------------------------------------
describe('extractTextFromParts', () => {
  test('extracts text from spec parts', () => {
    const result = extractTextFromParts([{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }])
    assert.equal(result, 'hello world')
  })

  test('handles legacy {text} parts', () => {
    const result = extractTextFromParts([{ text: 'foo' }, { text: 'bar' }])
    assert.equal(result, 'foo bar')
  })

  test('skips non-text parts gracefully', () => {
    const result = extractTextFromParts([{ kind: 'text', text: 'hi' }, { kind: 'raw', raw: 'base64data' }])
    assert.equal(result, 'hi')
  })

  test('returns empty string for empty or invalid input', () => {
    assert.equal(extractTextFromParts([]), '')
    assert.equal(extractTextFromParts(null), '')
    assert.equal(extractTextFromParts(undefined), '')
  })
})

// ---------------------------------------------------------------------------
describe('autoRegister', () => {
  test('registers new session with defaults', () => {
    autoRegister('sess-1', 'test')
    assert.ok(registry.has('sess-1'))
    const entry = registry.get('sess-1')
    assert.equal(entry.status, 'running')
    assert.deepEqual(entry.skills, [])
    assert.equal(entry.label, 'auto-registered')
  })

  test('does not overwrite existing session', () => {
    registry.set('sess-1', { session_id: 'sess-1', label: 'original', status: 'running', skills: [] })
    autoRegister('sess-1', 'test')
    assert.equal(registry.get('sess-1').label, 'original')
  })

  test('passes skills through', () => {
    const skills = [{ id: 'coder', name: 'Coder', description: 'Writes code' }]
    autoRegister('sess-2', 'test', skills)
    assert.deepEqual(registry.get('sess-2').skills, skills)
  })
})

// ---------------------------------------------------------------------------
describe('buildCoordinatorCard', () => {
  test('returns valid A2A agent card', () => {
    const card = buildCoordinatorCard()
    assert.equal(card.protocolVersion, '1.0')
    assert.equal(card.name, 'calling-all-stations')
    assert.equal(card.url, 'http://test.local/a2a')
    assert.ok(Array.isArray(card.skills))
    assert.ok(card.skills.length >= 3)
  })

  test('skill ids are broadcast, route-directive, query-registry', () => {
    const card = buildCoordinatorCard()
    const ids = card.skills.map(s => s.id)
    assert.ok(ids.includes('broadcast'))
    assert.ok(ids.includes('route-directive'))
    assert.ok(ids.includes('query-registry'))
  })

  test('url uses SERVER_URL env var', () => {
    process.env.SERVER_URL = 'https://example.com'
    const card = buildCoordinatorCard()
    assert.equal(card.url, 'https://example.com/a2a')
  })

  test('card has provider, securitySchemes, interfaces fields', () => {
    const card = buildCoordinatorCard()
    assert.ok(card.provider, 'should have provider')
    assert.ok(typeof card.securitySchemes === 'object')
    assert.ok(Array.isArray(card.security))
    assert.ok(Array.isArray(card.interfaces))
    assert.ok(card.interfaces.some(i => i.transport === 'http'))
    assert.ok(card.interfaces.some(i => i.transport === 'mcp'))
  })

  test('card capabilities has stateTransitionHistory field', () => {
    const card = buildCoordinatorCard()
    assert.ok('stateTransitionHistory' in card.capabilities)
  })
})

// ---------------------------------------------------------------------------
describe('buildAgentCard', () => {
  test('returns null for unknown session', () => {
    assert.equal(buildAgentCard('unknown'), null)
  })

  test('returns card with declared skills', () => {
    const skills = [{ id: 'reviewer', name: 'Reviewer', description: 'Reviews code' }]
    registry.set('sess-a', {
      session_id: 'sess-a', label: 'My Agent', status: 'running',
      current_step: 'idle', skills,
    })
    const card = buildAgentCard('sess-a')
    assert.equal(card.name, 'My Agent')
    assert.equal(card.url, 'http://test.local/agents/sess-a/a2a')
    assert.deepEqual(card.skills, skills)
    assert.equal(card['x-proxy'].session_id, 'sess-a')
    assert.equal(card['x-proxy'].transport, 'mcp-push')
  })

  test('uses generic skill when none declared', () => {
    registry.set('sess-b', {
      session_id: 'sess-b', label: 'Unnamed', status: 'running',
      current_step: 'idle', skills: [],
    })
    const card = buildAgentCard('sess-b')
    assert.equal(card.skills.length, 1)
    assert.equal(card.skills[0].id, 'general')
  })

  test('card humanReadableId contains session_id', () => {
    registry.set('sess-c', {
      session_id: 'sess-c', label: 'Test', status: 'running', current_step: 'idle', skills: [],
    })
    const card = buildAgentCard('sess-c')
    assert.ok(card.humanReadableId.includes('sess-c'))
  })
})

// ---------------------------------------------------------------------------
describe('buildAgentDirectory', () => {
  test('returns empty agents array when registry empty', () => {
    const dir = buildAgentDirectory()
    assert.ok(Array.isArray(dir.agents))
    assert.equal(dir.agents.length, 0)
    assert.ok(dir.coordinator.includes('agent-card.json'))
  })

  test('lists all registered agents', () => {
    registry.set('s1', { session_id: 's1', label: 'A1', status: 'running', current_step: 'step1', skills: [] })
    registry.set('s2', { session_id: 's2', label: 'A2', status: 'stale',   current_step: 'done',  skills: [{ id: 'x' }] })
    const dir = buildAgentDirectory()
    assert.equal(dir.agents.length, 2)
    const a1 = dir.agents.find(a => a.session_id === 's1')
    assert.ok(a1.agent_card_url.includes('/agents/s1/agent-card.json'))
    assert.ok(a1.a2a_url.includes('/agents/s1/a2a'))
    const a2 = dir.agents.find(a => a.session_id === 's2')
    assert.deepEqual(a2.skills, ['x'])
  })
})

// ---------------------------------------------------------------------------
describe('buildSkillDirectory', () => {
  test('returns empty skills array when no skills declared', () => {
    registry.set('s1', { session_id: 's1', status: 'running', skills: [] })
    const dir = buildSkillDirectory()
    assert.deepEqual(dir.skills, [])
  })

  test('aggregates skills across agents', () => {
    registry.set('s1', {
      session_id: 's1', label: 'Agent1', status: 'running',
      skills: [{ id: 'coder', name: 'Coder' }, { id: 'reviewer', name: 'Reviewer' }],
    })
    registry.set('s2', {
      session_id: 's2', label: 'Agent2', status: 'running',
      skills: [{ id: 'coder', name: 'Coder' }],
    })
    const dir = buildSkillDirectory()
    assert.equal(dir.skills.length, 2)
    const coder = dir.skills.find(s => s.id === 'coder')
    assert.equal(coder.agents.length, 2)
    const reviewer = dir.skills.find(s => s.id === 'reviewer')
    assert.equal(reviewer.agents.length, 1)
  })
})

// ---------------------------------------------------------------------------
describe('Task management', () => {
  test('createTask returns task with submitted state', () => {
    const task = createTask('sess-1', { role: 'user', parts: [{ text: 'hello' }] })
    assert.equal(task.status.state, 'submitted')
    assert.equal(task.session_id, 'sess-1')
    assert.ok(task.id)
    assert.ok(tasks.has(task.id))
  })

  test('createTask assigns a contextId by default', () => {
    const task = createTask('sess-1', {})
    assert.ok(task.contextId, 'should have contextId')
  })

  test('createTask accepts explicit contextId', () => {
    const task = createTask('sess-1', {}, 'ctx-123')
    assert.equal(task.contextId, 'ctx-123')
  })

  test('updateTask updates fields', () => {
    const task = createTask('sess-1', {})
    updateTask(task.id, { status: { state: 'working' } })
    updateTask(task.id, { status: { state: 'completed' }, result: { answer: 42 } })
    const updated = getTask(task.id)
    assert.equal(updated.status.state, 'completed')
    assert.equal(updated.result.answer, 42)
  })

  test('getTask returns null for unknown id', () => {
    assert.equal(getTask('no-such-id'), null)
  })

  test('pruneExpiredTasks removes old tasks', () => {
    const task = createTask('s', {})
    // Backdate the task
    task.created_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    pruneExpiredTasks()
    assert.equal(getTask(task.id), null)
  })

  test('pruneExpiredTasks keeps fresh tasks', () => {
    const task = createTask('s', {})
    pruneExpiredTasks()
    assert.ok(getTask(task.id))
  })
})

// ---------------------------------------------------------------------------
describe('isValidTransition', () => {
  test('submitted → working is valid', () => assert.ok(isValidTransition('submitted', 'working')))
  test('submitted → completed is valid (sync coordinator)', () => assert.ok(isValidTransition('submitted', 'completed')))
  test('submitted → rejected is valid', () => assert.ok(isValidTransition('submitted', 'rejected')))
  test('working → completed is valid', () => assert.ok(isValidTransition('working', 'completed')))
  test('working → failed is valid', () => assert.ok(isValidTransition('working', 'failed')))
  test('working → input_required is valid', () => assert.ok(isValidTransition('working', 'input_required')))
  test('input_required → working is valid', () => assert.ok(isValidTransition('input_required', 'working')))
  test('completed → working is invalid', () => assert.ok(!isValidTransition('completed', 'working')))
  test('failed → working is invalid', () => assert.ok(!isValidTransition('failed', 'working')))
  test('canceled → completed is invalid', () => assert.ok(!isValidTransition('canceled', 'completed')))
  test('rejected → working is invalid', () => assert.ok(!isValidTransition('rejected', 'working')))
  test('TERMINAL_STATES covers completed/failed/canceled/rejected', () => {
    assert.ok(TERMINAL_STATES.has('completed'))
    assert.ok(TERMINAL_STATES.has('failed'))
    assert.ok(TERMINAL_STATES.has('canceled'))
    assert.ok(TERMINAL_STATES.has('rejected'))
  })
})

describe('updateTask — state transition validation', () => {
  test('allows valid transition submitted → working', () => {
    const task = createTask('s', {})
    const result = updateTask(task.id, { status: { state: 'working' } })
    assert.ok(!result?.error)
    assert.equal(getTask(task.id).status.state, 'working')
  })

  test('rejects invalid transition completed → working', () => {
    const task = createTask('s', {})
    updateTask(task.id, { status: { state: 'working' } })
    updateTask(task.id, { status: { state: 'completed' } })
    const result = updateTask(task.id, { status: { state: 'working' } })
    assert.ok(result?.error)
    assert.ok(result.error.includes('invalid_transition'))
    // State must not have changed
    assert.equal(getTask(task.id).status.state, 'completed')
  })

  test('non-state patches always succeed', () => {
    const task = createTask('s', {})
    const result = updateTask(task.id, { result: { foo: 'bar' } })
    assert.ok(!result?.error)
    assert.equal(getTask(task.id).result.foo, 'bar')
  })
})

describe('createTask — message normalization', () => {
  test('normalizes legacy parts on creation', () => {
    const task = createTask('s', { role: 'user', parts: [{ text: 'hello' }] })
    assert.equal(task.message.parts[0].kind, 'text')
    assert.equal(task.message.parts[0].text, 'hello')
  })

  test('preserves spec-compliant parts unchanged', () => {
    const part = { kind: 'text', text: 'hi', mediaType: 'text/plain' }
    const task = createTask('s', { parts: [part] })
    assert.deepEqual(task.message.parts[0], part)
  })

  test('stores metadata when provided', () => {
    const task = createTask('s', {}, null, { priority: 'high' })
    assert.deepEqual(task.metadata, { priority: 'high' })
  })

  test('no metadata field when not provided', () => {
    const task = createTask('s', {})
    assert.ok(!('metadata' in task))
  })

  test('stores extensions when provided', () => {
    const task = createTask('s', {}, null, null, { vendor: 'x' })
    assert.deepEqual(task.extensions, { vendor: 'x' })
  })

  test('no extensions field when not provided', () => {
    const task = createTask('s', {})
    assert.ok(!('extensions' in task))
  })
})

// ---------------------------------------------------------------------------
describe('validateA2aVersion', () => {
  test('returns null for null header (missing = tolerated)', () => {
    assert.equal(validateA2aVersion(null), null)
  })

  test('returns null for supported version', () => {
    assert.equal(validateA2aVersion('1.0'), null)
  })

  test('returns error for unsupported version', () => {
    const err = validateA2aVersion('99.0')
    assert.ok(err)
    assert.equal(err.error.code, -32003)
    assert.ok(err.error.message.includes('99.0'))
  })

  test('SUPPORTED_A2A_VERSIONS includes 1.0', () => {
    assert.ok(SUPPORTED_A2A_VERSIONS.includes('1.0'))
  })
})

// ---------------------------------------------------------------------------
describe('handleA2aRequest', () => {
  test('returns error for invalid jsonrpc version', () => {
    const res = handleA2aRequest({ jsonrpc: '1.0', id: 1, method: 'tasks/get', params: {} }, null, 'http://test.local')
    assert.equal(res.error.code, -32600)
  })

  test('tasks/get returns error for missing taskId', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }, null, 'http://test.local')
    assert.equal(res.error.code, -32602)
  })

  test('tasks/get returns error for unknown task', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'no-such' } }, null, 'http://test.local')
    assert.equal(res.error.code, -32001)
  })

  test('tasks/get returns task when found', () => {
    const task = createTask('s', {})
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: task.id } }, null, 'http://test.local')
    assert.equal(res.result.task.id, task.id)
  })

  test('message/send to unknown agent returns error', () => {
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [{ text: 'hi' }] } } },
      'no-such-session',
      'http://test.local'
    )
    assert.equal(res.error.code, -32001)
  })

  test('message/send to registered agent creates task and queues directive', () => {
    registry.set('sess-x', {
      session_id: 'sess-x', label: 'X', status: 'running',
      current_step: 'idle', skills: [],
    })
    inboxes.set('sess-x', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ text: 'do work' }] } } },
      'sess-x',
      'http://test.local'
    )
    assert.equal(res.result.task.status.state, 'working')
    const pending = inboxes.get('sess-x').filter(d => d.type === 'a2a_message')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].body.task_id, res.result.task.id)
  })

  test('message/send skill routing finds matching agent', () => {
    registry.set('sess-y', {
      session_id: 'sess-y', label: 'Y', status: 'running',
      current_step: 'idle', skills: [{ id: 'coder', name: 'Coder' }],
    })
    inboxes.set('sess-y', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'message/send', params: { skill: 'coder', message: { parts: [{ text: 'write code' }] } } },
      null,
      'http://test.local'
    )
    assert.ok(!res.error)
    assert.equal(res.result.task.session_id, 'sess-y')
    assert.equal(res.result.task.status.state, 'working')
  })

  test('message/send skill routing returns error when no agent has skill', () => {
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'message/send', params: { skill: 'nonexistent', message: { parts: [{ text: 'x' }] } } },
      null,
      'http://test.local'
    )
    assert.equal(res.error.code, -32001)
    assert.ok(res.error.message.includes('nonexistent'))
  })

  test('unknown method returns -32601', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'no/such', params: {} }, null, 'http://test.local')
    assert.equal(res.error.code, -32601)
  })

  test('message/send without message param returns error', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }, null, 'http://test.local')
    assert.equal(res.error.code, -32602)
  })

  // Spec-compliant method name aliases
  test('sendMessage is accepted as alias for message/send', () => {
    registry.set('sess-z', { session_id: 'sess-z', label: 'Z', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-z', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: { message: { role: 'user', parts: [{ text: 'hi' }] } } },
      'sess-z',
      'http://test.local'
    )
    assert.ok(!res.error)
    assert.equal(res.result.task.status.state, 'working')
  })

  test('getTask is accepted as alias for tasks/get', () => {
    const task = createTask('s', {})
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'getTask', params: { taskId: task.id } }, null, 'http://test.local')
    assert.equal(res.result.task.id, task.id)
  })

  test('cancelTask cancels a working task', () => {
    const task = createTask('s', {})
    updateTask(task.id, { status: { state: 'working' } })
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'cancelTask', params: { taskId: task.id } }, null, 'http://test.local')
    assert.ok(!res.error)
    assert.equal(res.result.task.status.state, 'canceled')
  })

  test('cancelTask returns error for unknown task', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'cancelTask', params: { taskId: 'no-such' } }, null, 'http://test.local')
    assert.equal(res.error.code, -32001)
  })

  test('cancelTask returns error when task already completed', () => {
    const task = createTask('s', {})
    updateTask(task.id, { status: { state: 'working' } })
    updateTask(task.id, { status: { state: 'completed' } })
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'cancelTask', params: { taskId: task.id } }, null, 'http://test.local')
    assert.equal(res.error.code, -32002)
  })

  test('listTasks returns all tasks', () => {
    createTask('s1', {})
    createTask('s2', {})
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'listTasks', params: {} }, null, 'http://test.local')
    assert.ok(!res.error)
    assert.equal(res.result.tasks.length, 2)
  })

  test('listTasks filters by contextId', () => {
    createTask('s1', {}, 'ctx-A')
    createTask('s2', {}, 'ctx-B')
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'listTasks', params: { contextId: 'ctx-A' } }, null, 'http://test.local')
    assert.equal(res.result.tasks.length, 1)
    assert.equal(res.result.tasks[0].contextId, 'ctx-A')
  })

  test('listTasks filters by status', () => {
    const t1 = createTask('s1', {})
    updateTask(t1.id, { status: { state: 'working' } })
    updateTask(t1.id, { status: { state: 'completed' } })
    createTask('s2', {}) // stays submitted
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'listTasks', params: { status: 'completed' } }, null, 'http://test.local')
    assert.equal(res.result.tasks.length, 1)
    assert.equal(res.result.tasks[0].status.state, 'completed')
  })

  test('getExtendedAgentCard returns coordinator card', () => {
    const res = handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'getExtendedAgentCard', params: {} }, null, 'http://test.local')
    assert.ok(!res.error)
    assert.equal(res.result.agentCard.name, 'calling-all-stations')
    assert.ok(Array.isArray(res.result.agentCard.skills))
  })

  test('sendMessage stores metadata on task', () => {
    registry.set('sess-meta', { session_id: 'sess-meta', label: 'M', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-meta', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: {
        metadata: { priority: 'high' },
        message: { parts: [{ kind: 'text', text: 'hi' }] }
      }},
      'sess-meta', 'http://test.local'
    )
    assert.ok(!res.error)
    assert.deepEqual(res.result.task.metadata, { priority: 'high' })
  })

  test('sendMessage stores extensions on task', () => {
    registry.set('sess-ext', { session_id: 'sess-ext', label: 'E', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-ext', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: {
        extensions: { vendor: 'acme' },
        message: { parts: [{ kind: 'text', text: 'hi' }] }
      }},
      'sess-ext', 'http://test.local'
    )
    assert.ok(!res.error)
    assert.deepEqual(res.result.task.extensions, { vendor: 'acme' })
  })

  test('rejectTask sets state to rejected', () => {
    registry.set('sess-rj', { session_id: 'sess-rj', label: 'RJ', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-rj', [])
    const task = createTask('sess-rj', {})
    updateTask(task.id, { status: { state: 'working' } })
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'rejectTask', params: { taskId: task.id, reason: 'out of scope' } },
      null, 'http://test.local'
    )
    assert.ok(!res.error)
    assert.equal(res.result.task.status.state, 'rejected')
    assert.equal(res.result.task.status.reason, 'out of scope')
  })

  test('rejectTask on submitted task is valid (submitted → rejected)', () => {
    const task = createTask('s', {})
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'rejectTask', params: { taskId: task.id } },
      null, 'http://test.local'
    )
    assert.ok(!res.error)
    assert.equal(res.result.task.status.state, 'rejected')
  })

  test('rejectTask on terminal task returns -32002', () => {
    const task = createTask('s', {})
    updateTask(task.id, { status: { state: 'working' } })
    updateTask(task.id, { status: { state: 'completed' } })
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'rejectTask', params: { taskId: task.id } },
      null, 'http://test.local'
    )
    assert.equal(res.error.code, -32002)
  })

  test('sendMessage passes returnImmediately in directive body', () => {
    registry.set('sess-ri', { session_id: 'sess-ri', label: 'RI', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-ri', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: { returnImmediately: false, message: { parts: [{ kind: 'text', text: 'hi' }] } } },
      'sess-ri', 'http://test.local'
    )
    assert.ok(!res.error)
    const directive = inboxes.get('sess-ri').find(d => d.type === 'a2a_message')
    assert.equal(directive.body.returnImmediately, false)
  })

  test('A2A-Version unsupported returns error', () => {
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'listTasks', params: {} },
      null, 'http://test.local',
      { a2aVersion: '99.0' }
    )
    assert.equal(res.error.code, -32003)
  })

  test('A2A-Version 1.0 is accepted', () => {
    createTask('s', {})
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'listTasks', params: {} },
      null, 'http://test.local',
      { a2aVersion: '1.0' }
    )
    assert.ok(!res.error)
  })

  test('contextId is passed through on sendMessage to agent', () => {
    registry.set('sess-ctx', { session_id: 'sess-ctx', label: 'C', status: 'running', current_step: 'idle', skills: [] })
    inboxes.set('sess-ctx', [])
    const res = handleA2aRequest(
      { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: { contextId: 'ctx-42', message: { parts: [{ text: 'hi' }] } } },
      'sess-ctx', 'http://test.local'
    )
    assert.equal(res.result.task.contextId, 'ctx-42')
  })
})
