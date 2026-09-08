# Codex subagent reference

Reviewed 2026-09-08. Applies only to a Codex session, regardless of model provider
or which compatible skill directory supplied these instructions.

## Suggested routing

| Role | Starting choice | Escalation |
| --- | --- | --- |
| Targeted search, inventories, extraction | `gpt-5.6-luna`, low; medium for exploration | Terra, medium |
| Implementation, tests, ordinary review, commit grouping | `gpt-5.6-terra`, medium | Sol, medium/high |
| Difficult diagnosis, high-risk review, arbitration | `gpt-5.6-sol`, medium/high | `gpt-6-astra`, medium/high for unresolved complex work |

These are workflow recommendations, not measured rankings for this repository.
The current desktop tool catalog advertises all four choices. Check the live
catalog on another host/session. Keep a user-selected root model; selecting a
worker does not require changing it. [Official model guidance](https://learn.chatgpt.com/docs/models)

## Runtime adapter

Use the native spawn, messaging, and wait tools exposed in this session. In the
desktop collaboration interface, `spawn_agent` takes `model`, `reasoning_effort`,
and `fork_turns`. With that interface, explicit model/effort overrides require
`fork_turns: "none"` or a positive bounded history count; a full-history fork
inherits settings. Supply a self-contained brief for a fresh context. Treat this
as a live desktop contract, not a universal CLI schema.

Codex also supports agent configuration under `.codex/agents/` and
`~/.codex/agents/`. A custom file can override spawn/default model settings, so
verify effective resolution. Use per-assignment selection rather than writing
global `[agents]` defaults that affect simultaneous sessions.
[Subagents and configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)

Do not assume spawning creates a worktree. The current collaboration interface
shares the directory and has no isolation argument: prepare the worktree yourself
and put its absolute path in the brief. Keep every command rooted there. Do not
create user-owned app tasks as an internal delegation substitute.
