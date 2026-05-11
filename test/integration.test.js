/**
 * Integration tests — spins up real HTTP server, hits all endpoints.
 * Run: node --test test/integration.test.js
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createAppServer, registry, inboxes, tasks } from '../server.js'

// Helpers
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function get(url) {
  const res = await fetch(url)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

// ---------------------------------------------------------------------------
let server
let base
let port

before(async () => {
  // Use random port to avoid conflicts
  port = 19000 + Math.floor(Math.random() * 1000)
  process.env.PORT = String(port)
  process.env.SERVER_URL = `http://localhost:${port}`
  process.env.STATE_FILE = `/tmp/switchboard-test-${port}.json`

  server = createAppServer()
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  delete process.env.PORT
  delete process.env.SERVER_URL
  delete process.env.STATE_FILE
})

beforeEach(() => {
  registry.clear()
  inboxes.clear()
  tasks.clear()
})

// ---------------------------------------------------------------------------
describe('GET /health', () => {
  test('returns ok with agent and task counts', async () => {
    const { status, json } = await get(`${base}/health`)
    assert.equal(status, 200)
    assert.equal(json.status, 'ok')
    assert.equal(typeof json.agents, 'number')
    assert.equal(typeof json.tasks, 'number')
  })
})

// ---------------------------------------------------------------------------
describe('POST /register', () => {
  test('registers an agent with no skills', async () => {
    const { status } = await post(`${base}/register`, { session_id: 'test-1', label: 'Test Agent' })
    assert.equal(status, 204)
    assert.ok(registry.has('test-1'))
    assert.deepEqual(registry.get('test-1').skills, [])
  })

  test('registers an agent with declared skills', async () => {
    const skills = [{ id: 'coder', name: 'Coder', description: 'Writes code' }]
    const { status } = await post(`${base}/register`, { session_id: 'test-2', label: 'Coder Agent', skills })
    assert.equal(status, 204)
    assert.deepEqual(registry.get('test-2').skills, skills)
  })

  test('ignores invalid skills value (non-array)', async () => {
    await post(`${base}/register`, { session_id: 'test-3', skills: 'not-an-array' })
    assert.deepEqual(registry.get('test-3').skills, [])
  })
})

// ---------------------------------------------------------------------------
describe('GET /.well-known/agent-card.json', () => {
  test('returns coordinator agent card', async () => {
    const { status, json } = await get(`${base}/.well-known/agent-card.json`)
    assert.equal(status, 200)
    assert.equal(json.protocolVersion, '1.0')
    assert.equal(json.name, 'calling-all-stations')
    assert.ok(json.url.includes('/a2a'))
    assert.ok(Array.isArray(json.skills))
    assert.ok(json.skills.some(s => s.id === 'broadcast'))
    assert.ok(json.skills.some(s => s.id === 'route-directive'))
    assert.ok(json.skills.some(s => s.id === 'query-registry'))
  })
})

// ---------------------------------------------------------------------------
describe('GET /agents/', () => {
  test('returns empty directory when no agents', async () => {
    const { status, json } = await get(`${base}/agents/`)
    assert.equal(status, 200)
    assert.ok(Array.isArray(json.agents))
    assert.equal(json.agents.length, 0)
    assert.ok(json.coordinator)
  })

  test('lists registered agents with card URLs', async () => {
    await post(`${base}/register`, {
      session_id: 'ag-1', label: 'Agent One',
      skills: [{ id: 'tester', name: 'Tester' }],
    })
    await post(`${base}/register`, { session_id: 'ag-2', label: 'Agent Two' })
    const { json } = await get(`${base}/agents/`)
    assert.equal(json.agents.length, 2)
    const ag1 = json.agents.find(a => a.session_id === 'ag-1')
    assert.ok(ag1.agent_card_url.includes('ag-1'))
    assert.ok(ag1.a2a_url.includes('ag-1'))
    assert.deepEqual(ag1.skills, ['tester'])
  })
})

// ---------------------------------------------------------------------------
describe('GET /agents/:id/agent-card.json', () => {
  test('returns 404 for unknown agent', async () => {
    const { status } = await get(`${base}/agents/no-such/agent-card.json`)
    assert.equal(status, 404)
  })

  test('returns card with declared skills', async () => {
    const skills = [{ id: 'builder', name: 'Builder', description: 'Builds things' }]
    await post(`${base}/register`, { session_id: 'card-1', label: 'Builder Bot', skills })
    const { status, json } = await get(`${base}/agents/card-1/agent-card.json`)
    assert.equal(status, 200)
    assert.equal(json.name, 'Builder Bot')
    assert.deepEqual(json.skills, skills)
    assert.ok(json.url.includes('/agents/card-1/a2a'))
    assert.equal(json['x-proxy'].session_id, 'card-1')
    assert.equal(json['x-proxy'].transport, 'mcp-push')
  })

  test('returns generic skill when none declared', async () => {
    await post(`${base}/register`, { session_id: 'card-2', label: 'Plain Agent' })
    const { json } = await get(`${base}/agents/card-2/agent-card.json`)
    assert.equal(json.skills.length, 1)
    assert.equal(json.skills[0].id, 'general')
  })
})

// ---------------------------------------------------------------------------
describe('GET /skills', () => {
  test('returns empty skills when no agents have skills', async () => {
    await post(`${base}/register`, { session_id: 's1', label: 'No Skills' })
    const { json } = await get(`${base}/skills`)
    assert.deepEqual(json.skills, [])
  })

  test('aggregates skills across agents', async () => {
    await post(`${base}/register`, {
      session_id: 'sk-1', label: 'A',
      skills: [{ id: 'coder', name: 'Coder' }, { id: 'reviewer', name: 'Reviewer' }],
    })
    await post(`${base}/register`, {
      session_id: 'sk-2', label: 'B',
      skills: [{ id: 'coder', name: 'Coder' }],
    })
    const { json } = await get(`${base}/skills`)
    assert.equal(json.skills.length, 2)
    const coder = json.skills.find(s => s.id === 'coder')
    assert.equal(coder.agents.length, 2)
    const reviewer = json.skills.find(s => s.id === 'reviewer')
    assert.equal(reviewer.agents.length, 1)
  })
})

// ---------------------------------------------------------------------------
describe('POST /a2a — coordinator', () => {
  test('returns error for invalid jsonrpc', async () => {
    const { json } = await post(`${base}/a2a`, { jsonrpc: '1.0', id: 1, method: 'tasks/get', params: {} })
    assert.equal(json.error.code, -32600)
  })

  test('tasks/get returns error for unknown task', async () => {
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'no-such' },
    })
    assert.equal(json.error.code, -32001)
  })

  test('message/send broadcasts when no session_id and no skill', async () => {
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 1,
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ text: 'hello all' }] } },
    })
    assert.ok(!json.error, JSON.stringify(json.error))
    assert.equal(json.result.task.status.state, 'completed')
  })

  test('message/send with skill routes to matching agent', async () => {
    await post(`${base}/register`, {
      session_id: 'a2a-agent-1',
      label: 'Skill Agent',
      skills: [{ id: 'analyzer', name: 'Analyzer' }],
    })
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2,
      method: 'message/send',
      params: { skill: 'analyzer', message: { parts: [{ text: 'analyze this' }] } },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.session_id, 'a2a-agent-1')
    assert.equal(json.result.task.status.state, 'working')
    // Verify directive landed in inbox
    const inbox = inboxes.get('a2a-agent-1') ?? []
    assert.ok(inbox.some(d => d.type === 'a2a_message'))
  })

  test('message/send with skill returns error when no match', async () => {
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 3,
      method: 'message/send',
      params: { skill: 'nonexistent-skill', message: { parts: [{ text: 'x' }] } },
    })
    assert.equal(json.error.code, -32001)
  })
})

// ---------------------------------------------------------------------------
describe('POST /agents/:id/a2a — per-agent proxy', () => {
  test('returns 200 with error for unknown agent', async () => {
    const { status, json } = await post(`${base}/agents/no-such/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { parts: [{ text: 'hi' }] } },
    })
    assert.equal(status, 200) // A2A always 200
    assert.equal(json.error.code, -32001)
  })

  test('routes message to agent inbox and creates task', async () => {
    await post(`${base}/register`, { session_id: 'proxy-1', label: 'Proxy Target' })
    const { json } = await post(`${base}/agents/proxy-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { role: 'user', parts: [{ text: 'do the thing' }] } },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.status.state, 'working')
    // Verify agent can receive via check-inbox
    const inbox = await post(`${base}/check-inbox`, { session_id: 'proxy-1' })
    assert.equal(inbox.json.directives.length, 1)
    assert.equal(inbox.json.directives[0].type, 'a2a_message')
    assert.equal(inbox.json.directives[0].body.task_id, json.result.task.id)
  })

  test('tasks/get returns task status after message/send', async () => {
    await post(`${base}/register`, { session_id: 'proxy-2', label: 'P2' })
    const send = await post(`${base}/agents/proxy-2/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { parts: [{ text: 'query' }] } },
    })
    const taskId = send.json.result.task.id
    const get_ = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId },
    })
    assert.equal(get_.json.result.task.id, taskId)
    assert.equal(get_.json.result.task.status.state, 'working')
  })
})

// ---------------------------------------------------------------------------
describe('Full A2A round-trip', () => {
  test('agent receives a2a_message and completes task via send-directive', async () => {
    // 1. Register agent
    await post(`${base}/register`, {
      session_id: 'rt-agent',
      label: 'Round-trip Agent',
      skills: [{ id: 'echo', name: 'Echo' }],
    })

    // 2. External A2A caller sends message to agent
    const send = await post(`${base}/agents/rt-agent/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { role: 'user', parts: [{ text: 'echo: hello' }] } },
    })
    assert.ok(!send.json.error)
    const taskId = send.json.result.task.id
    assert.equal(send.json.result.task.status.state, 'working')

    // 3. Agent polls check-inbox, finds the a2a_message directive
    const inbox = await post(`${base}/check-inbox`, { session_id: 'rt-agent' })
    assert.equal(inbox.json.directives.length, 1)
    const directive = inbox.json.directives[0]
    assert.equal(directive.type, 'a2a_message')
    assert.equal(directive.body.task_id, taskId)

    // 4. Agent simulates completing the task via send-directive (answer type)
    // In real usage: agent calls complete_task MCP tool
    // Here we directly update the task to simulate completion
    const { updateTask: ut } = await import('../server.js')
    ut(taskId, { status: { state: 'completed' }, result: { echo: 'hello' } })

    // 5. Verify task is now completed
    const check = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId },
    })
    assert.equal(check.json.result.task.status.state, 'completed')
    assert.deepEqual(check.json.result.task.result, { echo: 'hello' })
  })

  test('skill-based round-trip — coordinator routes to correct agent', async () => {
    // Register two agents, only one has the skill
    await post(`${base}/register`, { session_id: 'no-skill', label: 'No Skill' })
    await post(`${base}/register`, {
      session_id: 'has-skill',
      label: 'Has Skill',
      skills: [{ id: 'summarizer', name: 'Summarizer' }],
    })

    // Send via coordinator with skill hint
    const send = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: {
        skill: 'summarizer',
        message: { role: 'user', parts: [{ text: 'summarize this document' }] },
      },
    })
    assert.ok(!send.json.error)
    assert.equal(send.json.result.task.session_id, 'has-skill')

    // Verify directive in correct inbox only
    const skilled = inboxes.get('has-skill') ?? []
    const noSkill = inboxes.get('no-skill') ?? []
    assert.equal(skilled.filter(d => d.type === 'a2a_message').length, 1)
    assert.equal(noSkill.filter(d => d.type === 'a2a_message').length, 0)
  })
})

// ---------------------------------------------------------------------------
describe('POST /send with event=agent_response completes A2A task', () => {
  test('updates task state to completed', async () => {
    // Register agent and create a task via A2A
    await post(`${base}/register`, { session_id: 'resp-1', label: 'Response Agent' })
    const send = await post(`${base}/agents/resp-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { parts: [{ text: 'do work' }] } },
    })
    const taskId = send.json.result.task.id
    assert.equal(send.json.result.task.status.state, 'working')

    // Agent completes via HTTP /send
    await post(`${base}/send`, {
      event: 'agent_response',
      session_id: 'resp-1',
      task_id: taskId,
      result: { output: 'work done' },
    })

    // Verify task is completed
    const check = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId },
    })
    assert.equal(check.json.result.task.status.state, 'completed')
    assert.deepEqual(check.json.result.task.result, { output: 'work done' })
  })

  test('agent_response without task_id still broadcasts normally', async () => {
    const { json } = await post(`${base}/send`, {
      event: 'agent_response',
      session_id: 'anon',
      message: 'finished',
    })
    assert.equal(json.ok, true)
    assert.ok(json.message_id)
  })
})

// ---------------------------------------------------------------------------
describe('POST /a2a message/stream — SSE streaming', () => {
  test('returns SSE stream with working then completed events', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 42,
        method: 'message/stream',
        params: { message: { role: 'user', parts: [{ text: 'stream this' }] } },
      }),
    })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/event-stream'))

    const text = await res.text()
    const events = text.split('\n\n').filter(Boolean).map(chunk => {
      const dataLine = chunk.split('\n').find(l => l.startsWith('data:'))
      return dataLine ? JSON.parse(dataLine.slice(5)) : null
    }).filter(Boolean)

    assert.ok(events.length >= 2, `Expected at least 2 SSE events, got ${events.length}`)

    const working = events.find(e => e.result?.task?.status?.state === 'working')
    assert.ok(working, 'Should have a working state event')

    const completed = events.find(e => e.result?.task?.status?.state === 'completed')
    assert.ok(completed, 'Should have a completed state event')

    // Both events should have the same task id
    assert.equal(working.result.task.id, completed.result.task.id)
    assert.equal(working.id, 42)
  })

  test('stream returns error when message is missing', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: {} }),
    })
    const json = await res.json()
    assert.equal(json.error.code, -32602)
  })
})

// ---------------------------------------------------------------------------
describe('A2A spec-compliant method names', () => {
  test('sendMessage is accepted (spec name)', async () => {
    await post(`${base}/register`, { session_id: 'spec-1', label: 'Spec Agent' })
    const { json } = await post(`${base}/agents/spec-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { role: 'user', parts: [{ text: 'hello' }] } },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.status.state, 'working')
  })

  test('getTask is accepted (spec name)', async () => {
    await post(`${base}/register`, { session_id: 'spec-2', label: 'Spec2' })
    const send = await post(`${base}/agents/spec-2/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ text: 'x' }] } },
    })
    const taskId = send.json.result.task.id
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'getTask', params: { taskId },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.id, taskId)
  })

  test('sendStreamingMessage is accepted (spec name for SSE)', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 10,
        method: 'sendStreamingMessage',
        params: { message: { role: 'user', parts: [{ text: 'stream' }] } },
      }),
    })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/event-stream'))
    const text = await res.text()
    assert.ok(text.includes('working'))
    assert.ok(text.includes('completed'))
  })

  test('cancelTask via JSON-RPC', async () => {
    await post(`${base}/register`, { session_id: 'cancel-1', label: 'Cancel Target' })
    const send = await post(`${base}/agents/cancel-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ text: 'work' }] } },
    })
    const taskId = send.json.result.task.id
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'cancelTask', params: { taskId },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.status.state, 'canceled')
  })

  test('listTasks returns all tasks', async () => {
    await post(`${base}/register`, { session_id: 'list-1', label: 'List Agent' })
    await post(`${base}/agents/list-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ text: 'task 1' }] } },
    })
    await post(`${base}/agents/list-1/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'sendMessage',
      params: { message: { parts: [{ text: 'task 2' }] } },
    })
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 3, method: 'listTasks', params: {},
    })
    assert.ok(!json.error)
    assert.ok(json.result.tasks.length >= 2)
  })

  test('contextId is preserved through task creation', async () => {
    await post(`${base}/register`, { session_id: 'ctx-1', label: 'Context Agent' })
    const { json } = await post(`${base}/agents/ctx-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { contextId: 'my-ctx-id', message: { parts: [{ text: 'hello' }] } },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.contextId, 'my-ctx-id')
  })

  test('A2A-Version header is returned on all A2A responses', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'listTasks', params: {} }),
    })
    assert.equal(res.headers.get('a2a-version'), '1.0')
  })

  test('unsupported A2A-Version returns -32003', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '99.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'listTasks', params: {} }),
    })
    const json = await res.json()
    assert.equal(json.error.code, -32003)
  })
})

// ---------------------------------------------------------------------------
describe('input_required state and task resumption', () => {
  test('sending answer directive resumes input_required task to working', async () => {
    await post(`${base}/register`, { session_id: 'ir-1', label: 'IR Agent' })
    // Create task in working state
    const send = await post(`${base}/agents/ir-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ kind: 'text', text: 'do work' }] } },
    })
    const taskId = send.json.result.task.id

    // Move task to input_required via send with task_id
    await post(`${base}/send`, {
      event: 'agent_question',
      session_id: 'ir-1',
      question: 'which option?',
      blocking: true,
      task_id: taskId,
    })

    // Verify task is input_required
    const check1 = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'getTask', params: { taskId },
    })
    assert.equal(check1.json.result.task.status.state, 'input_required')

    // Send answer — task should resume to working
    await post(`${base}/send-directive`, {
      session_id: 'ir-1', type: 'answer', body: { answer: 'option A' },
    })
    const check2 = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 3, method: 'getTask', params: { taskId },
    })
    assert.equal(check2.json.result.task.status.state, 'working')
  })
})

describe('rejected and auth_required task states', () => {
  test('rejectTask via JSON-RPC returns rejected state', async () => {
    await post(`${base}/register`, { session_id: 'rj-1', label: 'Rejector' })
    const send = await post(`${base}/agents/rj-1/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ kind: 'text', text: 'do impossible thing' }] } },
    })
    const taskId = send.json.result.task.id
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'rejectTask', params: { taskId, reason: 'not capable' },
    })
    assert.ok(!json.error)
    assert.equal(json.result.task.status.state, 'rejected')
    assert.equal(json.result.task.status.reason, 'not capable')
  })

  test('cannot cancel a rejected task', async () => {
    await post(`${base}/register`, { session_id: 'rj-2', label: 'RJ2' })
    const send = await post(`${base}/agents/rj-2/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'sendMessage',
      params: { message: { parts: [{ kind: 'text', text: 'x' }] } },
    })
    const taskId = send.json.result.task.id
    await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 2, method: 'rejectTask', params: { taskId },
    })
    const { json } = await post(`${base}/a2a`, {
      jsonrpc: '2.0', id: 3, method: 'cancelTask', params: { taskId },
    })
    assert.equal(json.error.code, -32002)
  })
})

// ---------------------------------------------------------------------------
describe('Existing REST endpoints still work', () => {
  test('POST /register → POST /check-inbox → POST /send-directive round-trip', async () => {
    await post(`${base}/register`, { session_id: 'rest-1', label: 'REST Agent' })
    await post(`${base}/send-directive`, {
      session_id: 'rest-1', type: 'message', body: { text: 'hello' },
    })
    const inbox = await post(`${base}/check-inbox`, { session_id: 'rest-1' })
    assert.equal(inbox.json.directives.length, 1)
    assert.equal(inbox.json.directives[0].body.text, 'hello')
  })

  test('GET /registry returns all agents', async () => {
    await post(`${base}/register`, { session_id: 'reg-1', label: 'R1' })
    await post(`${base}/register`, { session_id: 'reg-2', label: 'R2' })
    const { json } = await get(`${base}/registry`)
    assert.ok(json.agents['reg-1'])
    assert.ok(json.agents['reg-2'])
  })
})
