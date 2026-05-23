# kiro-cli ACP — wire protocol reference

Everything here is verified against **`kiro-cli` Agent 2.4.1** (`kiro-cli acp`,
`protocolVersion: 1`). ACP messages are **newline-delimited JSON-RPC 2.0** over the
agent's stdin/stdout — one JSON object per line, no `Content-Length` framing.

The bundled client `scripts/kiro-acp.py` implements exactly the flow below. Read this
when you need to adapt it, debug a run, or build your own client.

## Launch

```bash
kiro-cli acp --trust-all-tools          # auto-approve every tool (unattended)
kiro-cli acp --trust-tools fs_read,...  # auto-approve only these
kiro-cli acp --agent NAME --model ID    # pick agent / model for the first session
```

Why `kiro-cli acp` and not `kiro-cli chat`: ACP is a structured, stateful JSON-RPC
channel (sessions, streamed tool calls, permission round-trips, resumable history),
which is what makes programmatic delegation reliable. `chat` is the human TUI.

## The four-step turn

### 1. `initialize` (client → agent)
```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{},
  "clientInfo":{"name":"kiro-acp.py","version":"1.0.0"}}}
```
Response advertises agent capabilities:
```json
{"jsonrpc":"2.0","id":0,"result":{
  "protocolVersion":1,
  "agentCapabilities":{"loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":false},
    "mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{}},
  "authMethods":[],
  "agentInfo":{"name":"Kiro CLI Agent","version":"2.4.1"}}}
```
**Why `clientCapabilities:{}` matters:** by advertising no `fs`/`terminal`
capability, you tell Kiro *not* to call back to you for file or shell operations —
Kiro uses its **own** built-in tools instead. That is what makes it an autonomous
delegate rather than a thing you have to service. (Advertise `fs`/`terminal` only if
you intend to implement `fs/read_text_file`, `fs/write_text_file`, `terminal/*`
handlers yourself.)

### 2. `session/new` (client → agent)
```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/abs/path","mcpServers":[]}}
```
Response carries the id you key everything else on, plus available modes/models:
```json
{"jsonrpc":"2.0","id":1,"result":{
  "sessionId":"c9b3c534-6b87-46d6-935a-f6057d46a13f",
  "modes":{"currentModeId":"kiro_default","availableModes":[/* kiro_default, kiro_planner, kiro_guide, … */]},
  "models":{"currentModelId":"auto","availableModels":[/* claude-opus-4.6, … */]}}}
```
`cwd` **must be absolute.** To continue an earlier session use `session/load` with
the same params plus `sessionId` (requires `agentCapabilities.loadSession: true`).

### 3. `session/prompt` (client → agent)
```json
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{
  "sessionId":"c9b3c534-…",
  "prompt":[{"type":"text","text":"Reply with exactly: PONG"}]}}
```
> **Gotcha:** the content field is **`prompt`**, not `content`. Sending `content`
> produces no error and no reply — the turn just hangs. Content blocks are
> `{"type":"text","text":...}` (and `image` when `promptCapabilities.image`).

### 4. Stream + terminate (agent → client)
While working, Kiro emits `session/update` notifications (no `id`):
```json
{"method":"session/update","params":{"sessionId":"…","update":{
  "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PONG"}}}}
```
`update.sessionUpdate` is one of: `agent_message_chunk` (assistant text),
`agent_thought_chunk` (reasoning), `tool_call` (a tool starts — fields `toolCallId`,
sometimes `name`/`title`, and `rawInput`; Kiro's fs/shell action is often under
`rawInput.command`, e.g. `{"command":"create","path":"hello.txt","content":"…"}`),
and `tool_call_update` (`status` → `in_progress`/`completed`/`failed`).

The turn ends with the **response to your `session/prompt`**:
```json
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
```
`stopReason` ∈ `end_turn` (success), `max_tokens`, `cancelled`, `refusal`. Detect end
of turn by matching the response `id` to your prompt id — not by any notification.

## `_kiro.dev/*` extensions (Kiro-specific, safe to ignore)

Kiro layers extras onto ACP, prefixed `_kiro.dev/`:
- `_kiro.dev/metadata` (notification) — `contextUsagePercentage`, `meteringUsage`
  (credits), `turnDurationMs`. The client surfaces these in its `✓` trailer.
- `_kiro.dev/commands/available`, `_kiro.dev/commands/execute|options` — slash commands.
- `_kiro.dev/subagent/list_update`, `_kiro.dev/mcp/*`, `_kiro.dev/compaction/status`.

A minimal client can ignore every `_kiro.dev/*` notification and still complete turns.

## Permission requests

With `--trust-all-tools` Kiro does **not** send permission requests (verified). Without
it, Kiro sends a server→client request you must answer:
```json
// agent → client
{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{
  "toolCall":{"toolCallId":"tc_2","name":"shell","rawInput":{"command":"npm test"}},
  "options":[{"id":"allow_once","label":"Yes"},{"id":"allow_always","label":"Always"},
             {"id":"reject_once","label":"No"}]}}
// client → agent
{"jsonrpc":"2.0","id":7,"result":{"outcome":{"type":"selected","optionId":"allow_once"}}}
```
The client always picks an `allow*` option defensively, so a run never deadlocks on a
permission prompt even if trust flags change.

## Session storage & logging

- Transcripts persist to `~/.kiro/sessions/cli/<session-id>.json` and `.jsonl` —
  inspect these to see exactly what a delegated run did.
- Verbosity: `KIRO_LOG_LEVEL=debug kiro-cli acp`; redirect logs with
  `KIRO_CHAT_LOG_FILE=/path/to.log`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No stdout at all from a wrapper | Python buffers stdout when piped; run `python3 -u`. The client already flushes. |
| Prompt hangs, no reply, no error | You sent `content` instead of `prompt` in `session/prompt`. |
| Login prompt / empty results | Not authenticated: run `kiro-cli whoami`; log in if needed. |
| `cwd` errors on `session/new` | `cwd` must be an **absolute** path. |
| Run never returns | Bump `--timeout`; the client sends `session/cancel` and exits non-zero on timeout. |
| Kiro asks to read/write through you | You advertised `fs`/`terminal` capabilities — drop them to `{}` so Kiro uses its own tools. |

## Sources

- Kiro CLI ACP docs — https://kiro.dev/docs/cli/acp/
- "Kiro adopts ACP" — https://kiro.dev/blog/kiro-adopts-acp/
- Agent Client Protocol — https://agentclientprotocol.com/
