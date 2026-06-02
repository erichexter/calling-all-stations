/**
 * Unit tests for the directive lifecycle (#251 secondary tools):
 * indexDirective, findDirective, setDirectiveStatus, directiveStatusReport,
 * listDirectives, peekInbox.
 *
 * Run: node --test test/directive-lifecycle.test.js
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registry, inboxes, tasks, directiveIndex,
  mcpSessions,
  DIRECTIVE_STATUSES, DIRECTIVE_TERMINAL,
  indexDirective, findDirective, setDirectiveStatus,
  directiveStatusReport, listDirectives, peekInbox,
  hasLiveMcpFromWakeupHost,
} from '../server.js'

function newDirective(over = {}) {
  return {
    id: over.id ?? `d-${Math.random().toString(36).slice(2, 10)}`,
    type: over.type ?? 'message',
    body: over.body ?? { text: 'hello' },
    sent_at: over.sent_at ?? new Date().toISOString(),
    delivered: over.delivered ?? false,
    to_session: over.to_session ?? 'sess-a',
    from_session: over.from_session ?? 'wolf',
    ...over,
  }
}

beforeEach(() => {
  registry.clear()
  inboxes.clear()
  tasks.clear()
  directiveIndex.clear()
})

describe('indexDirective + findDirective', () => {
  test('stamps default status=pending on first index', () => {
    const d = newDirective()
    indexDirective('sess-a', d)
    assert.equal(findDirective(d.id), d)
    assert.equal(d.status, 'pending')
    assert.deepEqual(d.status_history, [])
  })

  test('respects existing status', () => {
    const d = newDirective({ status: 'delivered' })
    indexDirective('sess-a', d)
    assert.equal(findDirective(d.id).status, 'delivered')
  })

  test('uses delivered=true to infer status when not set', () => {
    const d = newDirective({ delivered: true })
    delete d.status
    indexDirective('sess-a', d)
    assert.equal(d.status, 'delivered')
  })

  test('returns null for unknown id', () => {
    assert.equal(findDirective('does-not-exist'), null)
  })

  test('ignores directives missing id', () => {
    indexDirective('sess-a', { type: 'message' })
    assert.equal(directiveIndex.size, 0)
  })
})

describe('setDirectiveStatus', () => {
  test('valid transition records history + returns prev_status', () => {
    const d = newDirective()
    indexDirective('sess-a', d)
    const r = setDirectiveStatus(d.id, 'read', 'opened by agent', 'smiley')
    assert.equal(r.ok, true)
    assert.equal(r.prev_status, 'pending')
    assert.equal(r.status, 'read')
    const found = findDirective(d.id)
    assert.equal(found.status, 'read')
    assert.equal(found.status_history.length, 1)
    assert.equal(found.status_history[0].status, 'read')
    assert.equal(found.status_history[0].note, 'opened by agent')
    assert.equal(found.status_history[0].by, 'smiley')
    assert.ok(found.read_at, 'read_at stamped on first read')
  })

  test('rejects invalid status', () => {
    const d = newDirective()
    indexDirective('sess-a', d)
    const r = setDirectiveStatus(d.id, 'banana')
    assert.equal(r.ok, false)
    assert.match(r.error, /invalid_status/)
    assert.ok(r.valid.includes('completed'))
  })

  test('errors on unknown directive', () => {
    const r = setDirectiveStatus('no-such-id', 'completed')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'directive_not_found')
  })

  test('multiple transitions accumulate history but only first read stamps read_at', () => {
    const d = newDirective()
    indexDirective('sess-a', d)
    setDirectiveStatus(d.id, 'read', null, 'smiley')
    const firstReadAt = findDirective(d.id).read_at
    setDirectiveStatus(d.id, 'accepted', null, 'smiley')
    setDirectiveStatus(d.id, 'read', null, 'smiley')  // second read shouldn't overwrite
    const found = findDirective(d.id)
    assert.equal(found.read_at, firstReadAt)
    assert.equal(found.status_history.length, 3)
    assert.equal(found.status, 'read')
  })

  test('all DIRECTIVE_TERMINAL states are members of DIRECTIVE_STATUSES', () => {
    for (const s of DIRECTIVE_TERMINAL) {
      assert.ok(DIRECTIVE_STATUSES.has(s), `terminal ${s} should be valid`)
    }
  })
})

describe('directiveStatusReport', () => {
  test('returns null for unknown directive', () => {
    assert.equal(directiveStatusReport('nope'), null)
  })

  test('returns shape with effective status fallback', () => {
    const d = newDirective({ delivered: true })
    delete d.status
    indexDirective('sess-a', d)
    const report = directiveStatusReport(d.id)
    assert.equal(report.directive_id, d.id)
    assert.equal(report.status, 'delivered')
    assert.equal(report.delivered, true)
    assert.equal(report.to_session, 'sess-a')
    assert.equal(report.from, 'wolf')
  })

  test('includes status_history after transitions', () => {
    const d = newDirective()
    indexDirective('sess-a', d)
    setDirectiveStatus(d.id, 'read', 'n', 'smiley')
    setDirectiveStatus(d.id, 'completed', 'done', 'smiley')
    const report = directiveStatusReport(d.id)
    assert.equal(report.status_history.length, 2)
    assert.equal(report.status, 'completed')
  })
})

describe('listDirectives', () => {
  beforeEach(() => {
    indexDirective('a', newDirective({ id: 'd1', to_session: 'a', from_session: 'wolf', sent_at: '2026-06-02T10:00:00Z' }))
    indexDirective('a', newDirective({ id: 'd2', to_session: 'a', from_session: 'wolf', sent_at: '2026-06-02T11:00:00Z' }))
    indexDirective('b', newDirective({ id: 'd3', to_session: 'b', from_session: 'mike',  sent_at: '2026-06-02T12:00:00Z' }))
    setDirectiveStatus('d1', 'completed', null, 'a')
  })

  test('filters by to_session', () => {
    const r = listDirectives({ to_session: 'a' })
    assert.equal(r.length, 2)
    assert.ok(r.every(d => d.to_session === 'a'))
  })

  test('filters by from_session', () => {
    const r = listDirectives({ from_session: 'mike' })
    assert.equal(r.length, 1)
    assert.equal(r[0].directive_id, 'd3')
  })

  test('filters by status', () => {
    const r = listDirectives({ status: 'completed' })
    assert.equal(r.length, 1)
    assert.equal(r[0].directive_id, 'd1')
  })

  test('returns newest first', () => {
    const r = listDirectives({})
    assert.deepEqual(r.map(d => d.directive_id), ['d3', 'd2', 'd1'])
  })
})

describe('hasLiveMcpFromWakeupHost (channel-vs-wakeup gating)', () => {
  beforeEach(() => { mcpSessions.clear() })

  test('false when no MCP sessions exist at all', () => {
    assert.equal(hasLiveMcpFromWakeupHost('http://192.168.1.231:19001/directive'), false)
  })

  test('false when no session originates from the wakeup_url host', () => {
    mcpSessions.set('a', { remote: '192.168.1.99', server: {}, transport: {} })
    assert.equal(hasLiveMcpFromWakeupHost('http://192.168.1.231:19001/directive'), false)
  })

  test('true when an MCP session is alive from the wakeup_url host', () => {
    mcpSessions.set('a', { remote: '192.168.1.231', server: {}, transport: {} })
    assert.equal(hasLiveMcpFromWakeupHost('http://192.168.1.231:19001/directive'), true)
  })

  test('handles IPv4-mapped IPv6 (::ffff:192.168.1.231 → 192.168.1.231)', () => {
    mcpSessions.set('a', { remote: '::ffff:192.168.1.231', server: {}, transport: {} })
    assert.equal(hasLiveMcpFromWakeupHost('http://192.168.1.231:19001/directive'), true)
  })

  test('false on garbage wakeup_url', () => {
    mcpSessions.set('a', { remote: '192.168.1.231', server: {}, transport: {} })
    assert.equal(hasLiveMcpFromWakeupHost('not a url'), false)
    assert.equal(hasLiveMcpFromWakeupHost(null), false)
    assert.equal(hasLiveMcpFromWakeupHost(undefined), false)
  })

  test('ignores sessions with no remote field', () => {
    mcpSessions.set('a', { remote: null, server: {}, transport: {} })
    mcpSessions.set('b', { server: {}, transport: {} })
    assert.equal(hasLiveMcpFromWakeupHost('http://192.168.1.231:19001/directive'), false)
  })
})

describe('peekInbox', () => {
  test('returns undelivered directives without marking delivered', () => {
    const d1 = newDirective({ id: 'p1', delivered: false })
    const d2 = newDirective({ id: 'p2', delivered: true })
    inboxes.set('sess-a', [d1, d2])
    const peeked = peekInbox('sess-a')
    assert.equal(peeked.length, 1)
    assert.equal(peeked[0].id, 'p1')
    // peek must not flip the flag
    assert.equal(d1.delivered, false)
  })

  test('empty for unknown session', () => {
    assert.deepEqual(peekInbox('ghost'), [])
  })

  test('can be called repeatedly without consuming', () => {
    inboxes.set('sess-a', [newDirective({ id: 'p1' })])
    assert.equal(peekInbox('sess-a').length, 1)
    assert.equal(peekInbox('sess-a').length, 1)
    assert.equal(peekInbox('sess-a').length, 1)
  })
})
