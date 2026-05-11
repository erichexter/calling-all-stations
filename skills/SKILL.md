# calling-all-stations — Agent Skill

Add this to your agent's AGENTS.md or CLAUDE.md:

```
Read skills/SKILL.md from calling-all-stations before starting work.
```

Or paste the rules below directly into your agent config.

---

## Rules

**On startup:** Register with the server using your session ID.

```json
POST /register
{ "session_id": "<your-session-id>", "label": "<task-name>" }
```

**Between major steps:** Call `check_inbox` (MCP tool) or `POST /check-inbox`. If directives arrive:
- `answer` — use the answer and continue
- `redirect` — change your current approach to match the instruction
- `abort` — stop work cleanly, comment reason on any tracked issue

**To ask a question:** Send an `agent_question` event and poll for the reply.

```json
POST /send
{ "event": "agent_question", "session_id": "<id>", "question": "...", "blocking": true }
```

Then poll `POST /check-inbox` every 5s until a directive with `type: "answer"` arrives (timeout: 5 minutes). Use the answer and continue — do not wait indefinitely.

**To broadcast status:** Send `agent_status` so other agents and operators can see your progress.

```json
POST /send
{ "event": "agent_status", "session_id": "<id>", "message": "...", "step": "fetch-data" }
```

**When done:** Deregister.

```
DELETE /deregister/<session-id>
```

---

## MCP (Claude Code)

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

Three tools are then available: `send`, `check_inbox`, `send_directive`.

Use `check_inbox` and `send` directly. Use `send_directive` to answer another agent's question.

---

## Receiving notifications

When a `<channel source="calling-all-stations">` notification arrives:

- `event=agent_question` — another agent needs an answer. Call `send_directive` with `type="answer"` immediately.
- `event=agent_status` — another agent updated its step. Log or act as needed.
- `event=issue_complete` — an agent finished. Act on it now, don't wait for next tick.
