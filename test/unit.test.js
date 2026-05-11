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

  test('updateTask updates fields', () => {
    const task = createTask('sess-1', {})
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
})
