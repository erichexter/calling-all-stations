# calling-all-stations

A lightweight multi-agent coordination server supporting both [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) and the [Agent-to-Agent (A2A) protocol v1.0](https://a2a-protocol.org/).

Agents register, broadcast events, ask questions, and receive directed replies through a shared registry and inbox system. Claude agents connect via MCP. LangGraph, Bedrock, Vertex AI, and other A2A-compatible runtimes connect via A2A. Any other agent connects via REST.

```
┌─ calling-all-stations ──────────────────────────────────────┐
│  Registry  │  Inbox/Directives  │  Task Store  │  Broadcast │
├─────────────────────────────────────────────────────────────┤
│  MCP Streamable HTTP  │  A2A JSON-RPC 2.0  │  REST HTTP    │
│  (Claude, MCP agents) │  (LangGraph, etc.) │  (any client) │
└─────────────────────────────────────────────────────────────┘
```

---

## What it does

- **Registry** — agents announce themselves, their status, and their declared skills
- **Inbox** — directed messages queue per-agent and are returned on next `check_inbox`
- **Broadcast** — push notifications to all connected MCP sessions instantly
- **Agent Q&A** — agent asks a question, operator/orchestrator answers via `send_directive`
- **A2A tasks** — external A2A agents send tasks via standard JSON-RPC 2.0; tasks are routed to registered agents via MCP push and tracked through completion
- **Skill routing** — A2A callers can route by skill ID; the server finds the first available agent with that skill
- **Agent Cards** — auto-generated A2A agent cards for the coordinator and each registered agent

```
Agent A ──send(agent_question)──► calling-all-stations ──broadcast──► Agent B / operator
Agent B ──send_directive──────► calling-all-stations ──inbox──────► Agent A (check_inbox)
```

## Quick start

```bash
npm install
node server.js
```

Server starts on `http://0.0.0.0:8788`.

### Connect via A2A

Any A2A-compatible runtime (LangGraph, AWS Bedrock AgentCore, Google Vertex AI, Azure AI, Strands) can interact without MCP:

```bash
# Discover coordinator capabilities
curl http://localhost:8788/.well-known/agent-card.json

# List all registered agents
curl http://localhost:8788/agents/

# See all declared skills across agents
curl http://localhost:8788/skills

# Send a task to a specific agent
curl -X POST http://localhost:8788/agents/<session_id>/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sendMessage","params":{"message":{"role":"user","parts":[{"kind":"text","text":"your task here"}]}}}'

# Route by skill (coordinator picks the right agent)
curl -X POST http://localhost:8788/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sendMessage","params":{"skill":"code-review","message":{"parts":[{"kind":"text","text":"review this PR"}]}}}'

# Poll task status
curl -X POST http://localhost:8788/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":2,"method":"getTask","params":{"taskId":"<task-id>"}}'

# Cancel a task
curl -X POST http://localhost:8788/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":3,"method":"cancelTask","params":{"taskId":"<task-id>"}}'

# List tasks (filter by contextId or status)
curl -X POST http://localhost:8788/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":4,"method":"listTasks","params":{"contextId":"<ctx-id>","status":"working"}}'
```

### Connect via MCP (Claude Code)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "calling-all-stations": {
      "type": "http",
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

Five MCP tools become available: `send`, `check_inbox`, `send_directive`, `complete_task`, `reject_task`.

### Connect via REST (any agent)

No MCP required — use the HTTP endpoints directly.

### Register with skills (for A2A routing)

Declare your agent's skills on registration so A2A callers can route to you by capability:

```json
POST /register
{
  "session_id": "your-uuid",
  "label": "My Agent",
  "skills": [
    {
      "id": "code-review",
      "name": "Code Reviewer",
      "description": "Reviews pull requests and suggests improvements",
      "inputModes": ["text/plain", "application/json"],
      "outputModes": ["text/plain", "application/json"]
    }
  ]
}
```

Once registered, your agent gets an auto-generated A2A card at `/agents/<session_id>/agent-card.json` and appears in the `/skills` directory.

### Completing an A2A task

When you receive a directive with `type: "a2a_message"` via `check_inbox`, process it and call `complete_task` MCP tool (or `POST /send` with `event=agent_response`) to mark it done:

```json
// check_inbox returns:
{ "directives": [{ "type": "a2a_message", "body": { "task_id": "uuid", "message": {...} } }] }

// Complete via MCP tool:
complete_task({ "task_id": "uuid", "result": { "answer": "..." } })
```

### Agent skill

Drop `skills/SKILL.md` into your project and add one line to your agent config:

```
Read skills/SKILL.md from calling-all-stations before starting work.
```

That's the full integration — the skill tells your agent when to register, when to check inbox, how to ask questions, and how to handle incoming directives.

---

## Running persistently

### PM2 (recommended for Linux/Mac)

```bash
npm install -g pm2
pm2 start server.js --name calling-all-stations
pm2 save
pm2 startup
```

### systemd (Linux)

```ini
[Unit]
Description=calling-all-stations
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/calling-all-stations/server.js
Restart=always
Environment=PORT=8788
Environment=STATE_FILE=/opt/calling-all-stations/state.json

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable calling-all-stations
sudo systemctl start calling-all-stations
```

### Docker

```bash
docker run -d \
  --name calling-all-stations \
  -p 8788:8788 \
  -e STATE_FILE=/data/state.json \
  -v $(pwd)/data:/data \
  node:20-alpine sh -c "npm install && node server.js"
```

### Windows (Task Scheduler)

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "C:\calling-all-stations\server.js" `
  -WorkingDirectory "C:\calling-all-stations"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "CallingAllStations" -Action $action -Trigger $trigger -RunLevel Highest
```

---

## A2A Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/agent-card.json` | Coordinator agent card (A2A discovery) |
| GET | `/agents/` | Directory of all registered agents with card URLs |
| GET | `/agents/:id/agent-card.json` | Per-agent proxy card (auto-generated from registry) |
| GET | `/skills` | Aggregated skill directory across all registered agents |
| POST | `/a2a` | Coordinator A2A endpoint (broadcast or skill-route) |
| POST | `/agents/:id/a2a` | Per-agent proxy A2A endpoint (routes to specific agent) |

**A2A JSON-RPC methods (spec-compliant names):**

| Method | Alias | Description |
|---|---|---|
| `sendMessage` | `message/send` | Send a task to an agent or broadcast |
| `sendStreamingMessage` | `message/stream` | Send and stream status via SSE |
| `getTask` | `tasks/get` | Poll task status by taskId |
| `cancelTask` | — | Cancel a non-terminal task |
| `listTasks` | — | List tasks, filter by contextId / status |

All A2A endpoints return HTTP 200 with JSON-RPC 2.0 responses (errors in the payload, not the HTTP status). Every response includes an `A2A-Version: 1.0` header. Pass `A2A-Version: 1.0` on requests for strict version validation.

**Task states:** `submitted` → `working` → `completed` | `failed` | `canceled` | `input_required` | `rejected` | `auth_required`

**Part schema** (A2A v1.0): `{ kind: "text"|"raw"|"url"|"data", text|raw|url|data, mediaType?, filename? }`  
Legacy `{ text: "..." }` is accepted and auto-upgraded.

**Artifact schema**: `{ artifactId, name, description, parts[], metadata? }`

**contextId**: Groups related tasks in a conversation. Auto-generated per task unless provided by the caller in `params.contextId`.

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
| `STATE_FILE` | `./calling-all-stations-state.json` | State persistence path   |

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
