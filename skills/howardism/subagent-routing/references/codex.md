# Codex subagent reference

Regenerate these facts with `codex --version` and the live `spawn_agent` schema in
a Codex session. Last checked against codex-cli 0.154.0. Applies only to a Codex
session, regardless of model provider or which compatible skill directory supplied
these instructions.

## Suggested routing

| Role | Starting choice | Escalation |
| --- | --- | --- |
| Targeted search, inventories, extraction | `gpt-5.3-codex-spark`; `gpt-5.6-luna`, low, once the scan needs judgment | Terra, medium |
| Implementation, tests, ordinary review, commit grouping | `gpt-5.6-terra`, medium | Sol, medium/high |
| Difficult diagnosis, high-risk review, arbitration | `gpt-5.6-sol`, medium/high | `gpt-6-astra`, medium/high for unresolved complex work |

The recommended catalog is `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, and `gpt-5.3-codex-spark`. `gpt-5.5` retires 2026-10-14, and
`gpt-5.4` and `gpt-5.4-mini` retire 2026-08-31. These are workflow
recommendations, not measured rankings for this repository; check the live catalog
on another host or session. Keep a user-selected root model; selecting a worker
does not require changing it.
[Official model guidance](https://learn.chatgpt.com/docs/models)

Documented reasoning efforts are Light, Medium, High, Extra High, Max, and Ultra.
Those are display names, so the table's low/medium/high are role guidance: read
the accepted values off the live schema.

## Runtime adapter

Use the native spawn, messaging, and wait tools exposed in this session. In the
desktop collaboration interface, `spawn_agent` takes `model`, `reasoning_effort`,
and `fork_turns`. With that interface, explicit model/effort overrides require
`fork_turns: "none"` or a positive bounded history count; a full-history fork
inherits settings. Treat this as a live desktop contract, not a universal CLI
schema.

Built-in agents are `default` (general-purpose), `worker` (execution-focused), and
`explorer` (read-heavy exploration).

Custom agents are standalone TOML files under `~/.codex/agents/` (personal) and
`.codex/agents/` (project). Three fields are required: `name`, the identifier used
when spawning and the source of truth for identity, with a matching filename only
conventional; `description`, human-facing guidance on when to use the agent; and
`developer_instructions`, its core behavioural instructions. A definition can also
override `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and
`skills.config`. Specifying only `model` preserves the previously resolved
reasoning effort.

Global `[agents]` keys reach every simultaneous session, so prefer per-assignment
selection over writing `agents.enabled` (default true),
`agents.max_concurrent_threads_per_session`, `agents.default_subagent_model`,
`agents.default_subagent_reasoning_effort`, or `agents.interrupt_message`
(default true).
[Subagents and configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)

Spawning creates no worktree: the current collaboration interface shares the
directory and has no isolation argument, so keep every command rooted in the
worktree named in the brief. Do not create user-owned app tasks as an internal
delegation substitute.
