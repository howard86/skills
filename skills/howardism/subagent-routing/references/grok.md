# Grok Build subagent reference

Regenerate these facts with `grok --version`, `grok models`, and the installed
guide at `~/.grok/docs/user-guide/16-subagents.md`, whose relevant sections are
"Personas", "Persona Resolution", "Spawning Subagents", "Capability Modes",
"Per-Type Toggles and Model Overrides", and "Depth Limits". Last checked against
Grok Build 1.0.35. Applies to the official Grok Build CLI, not every third-party
command named `grok`.

## Suggested routing

`grok models` on 1.0.35 lists only **`grok-4.7`**, also the default, so all three
role tiers share one model. Differentiate workloads with
agent type, capability mode, and role or persona defaults.

| Role | Agent type and capability mode |
| --- | --- |
| Investigation or inventories | `explore`, `read-only` |
| Implementation, tests, commit grouping | `general-purpose`, `all` |
| High-risk review or arbitration | independent `explore` or `general-purpose`, `read-only` |

Built-in agent types are `general-purpose` (the default, full capability),
`explore` (searches, reads, greps, and runs shell; does not edit files), and
`plan` (explores and returns a structured implementation plan; does not edit
files). The four capability modes are `read-only` (read, search, and inspect,
plus web search and LSP), `read-write` (read plus create, edit, delete, and move;
no shell), `execute` (read plus shell and background tasks; no file edits), and
`all`, which is unrestricted and the default for `general-purpose`.

## Per-child model and effort

Roles and personas carry the per-child settings, so a scout and an arbiter differ
by configuration rather than by model alias.

`[subagents.roles.<name>]` takes `description`, `default_capability_mode`,
`model`, and `prompt_file`. Roles are also discovered from `.grok/roles/*.toml`.

`[subagents.personas.<name>]` takes `instructions`, `instructions_file`,
`description`, `inputs`/`outputs`, `model`, `reasoning_effort`, and
`default_isolation` (`none` or `worktree`). Personas are discovered from
`.grok/personas/*.toml` (project), then `~/.grok/personas/*.toml` (user), then the
bundled set, lowest. Inline `config.toml` definitions beat files, and only `.toml`
is discovered.

Effective model and reasoning effort resolve highest first: an explicit spawn-time
override, the role default, the persona default, then the parent session. Isolation
follows the same first three steps and then defaults to `none` rather than
inheriting from the parent.

A persona is injected as a `<system-reminder>` and shapes tone, format, and focus;
agent type, model, and tools stay as resolved. Grok applies personas through
subagent resolution and roles, so the main agent names no persona when spawning. A
persona that cannot be resolved (missing, without instructions, or with an
unreadable `instructions_file`) fails the spawn.

Per-type configuration lives in `[subagents.toggle]`, which enables or disables a
type, and `[subagents.models]`, which routes a type to a model
(`explore = "grok-4.7"`). A per-type override applies for any parent; without one
the child inherits the parent's model. Avoid changing global routing while other
sessions are active.

## Runtime adapter

`spawn_subagent` takes `prompt`, `description`, `subagent_type` (default
`general-purpose`), `background` (default false), `isolation` (`none` by default,
or `worktree`), `resume_from` (continue a completed subagent by its ID), and
`cwd`. `cwd` is mutually exclusive with `isolation: worktree`, and ignored under
`resume_from` because the resumed child inherits its source's directory. Retain
the handle for background work and retrieve results with the exposed output tool.

Under `isolation: worktree` the child works in its own copy and its changes stay
isolated until merged, and the subagent's result includes the worktree path.
Merging back runs through the `x.ai/git/worktree/*` extension methods, including
the apply operation.

MCP inheritance is `all` (the default when omitted), `none`, `named: [server, …]`,
or `except: [server, …]`.

Only the top-level session spawns subagents: maximum nesting depth is one, and a
child that calls `spawn_subagent` fails with a depth-limit error.

The installed guide and the
[first-party source guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md)
differ on capability arguments: use the live tool schema, not a copied example.

Grok imports Claude skills/rules by default. Read the Grok branch even when this
reference arrived through `~/.claude/`; compatibility is not runtime identity.
[Compatibility documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces)
