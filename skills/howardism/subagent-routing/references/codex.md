# Codex subagent reference

Regenerate these facts with `codex --version`, `~/.codex/models_cache.json` (the
account's fetched catalog), and the live `spawn_agent` schema in a Codex session.
Last checked against codex-cli 0.154.0 with the catalog fetched 2026-09-23.
Applies only to a Codex session, regardless of model provider or which compatible
skill directory supplied these instructions.

## Suggested routing

| Role | Starting choice | Escalation |
| --- | --- | --- |
| Targeted search, inventories, extraction | `gpt-6-luna`, low; medium once the scan needs judgment | `gpt-6-sol`, medium |
| Implementation, tests, ordinary review, commit grouping | `gpt-6-sol`, medium | `gpt-6-astra`, medium |
| Difficult diagnosis, high-risk review, arbitration | `gpt-6-astra`, medium or high | `gpt-6-astra`, xhigh or max |

This account has the GPT-6 family: `gpt-6-astra` ("frontier intelligence for the
most demanding work", default effort medium), `gpt-6-sol` ("start here for
demanding agents"), and `gpt-6-luna` ("fast, narrowly scoped agents"). The CLI's
`models_cache.json` fetched 2026-09-23 listed only Astra among them, so the cache
under-reports the picker: confirm Sol and Luna in the live session. Behind them
sit `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` marked "Older", and
`gpt-5.5` as legacy, retiring 2026-10-14 with `gpt-5.6-sol` as its upgrade.
`gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark` are gone. Hidden entries
(`gpt-reserve`, `codex-auto-review`) are not routes. OpenAI's own worker
defaults are medium for Sol, high for Luna, and low for Astra, so a scout that
outgrows Luna can also step to Astra at low. These are workflow recommendations,
not measured rankings; keep a user-selected root model, since selecting a worker
does not require changing it.
[Official model guidance](https://learn.chatgpt.com/docs/models)

Catalog effort values are `low`, `medium`, `high`, `xhigh`, `max`, and, on Astra
and Sol, `ultra`. `ultra` is "maximum reasoning with automatic task delegation":
a worker at `ultra` spawns workers of its own, which breaks the common contract's
no-further-delegation stop, so cap workers at `max`. The desktop picker also shows
`persistent`; read accepted values off the live schema. An unconfigured worker
inherits the parent's model and effort.

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
