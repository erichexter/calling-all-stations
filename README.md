# switchboard

A lightweight multi-agent coordination server built on [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).

Agents register, broadcast events, ask questions, and receive directed replies through a shared registry and inbox system. Claude agents connect via MCP — any other runtime connects via the REST API.

---

## What it does

- **Registry** — agents announce themselves and their current step
- **Inbox** — directed messages queue per-agent and are returned on next `check_inbox`
- **Broadcast** — push notifications to all connected MCP sessions instantly
- **Agent Q&A** — agent asks a question (`agent_question`), another agent (or human operator) answers via `send_directive`, asker polls `check_inbox` for the reply

```
Agent A ──send(agent_question)──► switchboard ──broadcast──► Agent B / operator
Agent B ──send_directive──────► switchboard ──inbox──────► Agent A (check_inbox)
```

## Quick start

```bash
npm install
node server.js
```

Server starts on `http://0.0.0.0:8788`.

### Connect via MCP (Claude Code)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "switchboard": {
      "type": "http",
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

Three MCP tools become available: `send`, `check_inbox`, `send_directive`.

### Connect via REST (any agent)

No MCP required — use the HTTP endpoints directly.

---

## REST API

### `POST /register`
Register an agent session.
```json
{ "session_id": "uuid", "label": "my-agent", "issue_number": 42 }
```

### `DELETE /deregister/:session_id`
Remove a session from the registry.

### `POST /send`
Broadcast an event to all connected MCP sessions.
```json
{
  "event": "agent_status",
  "session_id": "uuid",
  "message": "Starting data fetch",
  "step": "fetch"
}
```
For questions:
```json
{
  "event": "agent_question",
  "session_id": "uuid",
  "question": "Which database should I use?",
  "blocking": true
}
```

### `POST /send-directive`
Send a directed message to a specific agent's inbox.
```json
{ "session_id": "target-uuid", "type": "answer", "body": { "answer": "SQLite" } }
```
Types: `answer`, `redirect`, `abort`, `message`

### `POST /check-inbox`
Fetch and mark-delivered all pending directives for a session.
```json
{ "session_id": "uuid" }
```
Returns:
```json
{ "directives": [{ "id": "...", "type": "answer", "body": {...}, "sent_at": "..." }] }
```

### `POST /status`
Update an agent's current step without broadcasting.
```json
{ "session_id": "uuid", "step": "processing" }
```

### `GET /registry`
List all registered agents and their state.

### `GET /health`
```json
{ "status": "ok", "port": 8788, "agents": 2, "mcp_sessions": 1 }
```

---

## Configuration

| Env var      | Default                         | Description              |
|--------------|---------------------------------|--------------------------|
| `PORT`       | `8788`                          | HTTP listen port         |
| `BIND_HOST`  | `0.0.0.0`                       | Bind address             |
| `STATE_FILE` | `./switchboard-state.json`      | State persistence path   |

---

## Agent-to-agent pattern

Any two agents that can reach the server can talk directly — no hub-and-spoke required:

1. Agent A registers, stores its `session_id`
2. Agent B calls `GET /registry` to find A's `session_id`
3. Agent B calls `POST /send-directive` with A's session_id
4. Agent A calls `POST /check-inbox` and receives the message

Works across agent runtimes (Claude, OpenAI, custom) as long as they can make HTTP requests.

---

## State persistence

Registry and undelivered inbox messages are written to `STATE_FILE` every 30 seconds and on each mutation. On restart, all sessions are restored with `status: "stale"` so operators can distinguish live from previous-run agents.

---

## License

MIT
