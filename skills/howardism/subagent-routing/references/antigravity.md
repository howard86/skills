# Antigravity subagent reference

Regenerate these facts with `agy --version`, `agy models`, and `agy --help`. Last
checked against AGY 1.2.4. Apply to Antigravity/AGY, not Gemini CLI merely because
both use a `.gemini` directory.

## Suggested routing

| Role | Native subagent tier | Related locally listed session model |
| --- | --- | --- |
| Search, extraction, mechanical groups | `flash` | `gemini-3.8-flash-low` |
| Bounded implementation, tests, commit grouping | `flash`; raise to `pro` when judgment warrants | `gemini-3.8-flash-medium` |
| Complex implementation, high-risk review, arbitration | `pro` | `gemini-3.1-pro-high` |

`agy models` on this account returns, in order, `gemini-3.8-flash-{high,medium,low}`,
`gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-{high,medium,low}`,
`gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`. Three flash generations
share one `flash` tier, so a tier can resolve to a concrete model other than the
one this table names: record the child's reported resolution, or say it is
unknown. `flash` is not a promise of 3.8.

## Runtime adapter

Use `invoke_subagent` and, when available, `define_subagent`. The `invoke_subagent`
workspace options are `inherit`, `share`, and `branch`, which creates an isolated
Git worktree; verify its repo, base, and path before relying on it. Its model tier is
`inherit`, `flash`, or `pro`. Calls are asynchronous: retain the child handle and
await its result. Maximum nesting depth is 10 levels.

AGY 1.2.4 adds a session `--agent` flag ("Agent for the current CLI session") and
`agent`/`agents` subcommands that list available agents.

A custom definition requires `name` and `description`, and optionally takes
`tools` (a string whitelist of exact tool names such as `view_file` or
`grep_search`), `model` (`inherit | flash | pro`), `commandExecutionPolicy`
(`off | auto | eager | sandbox`), `subagent` (boolean, enabling
`invoke_subagent`), `mainAgent` (boolean), `mcpServers`, and `skills`/`plugins`.
Definitions are discovered in the workspace at `.agents/agents/<name>.md` or
`.agents/agents/<name>/agent.md`, globally under `~/.gemini/config/agents/`, and
in plugins under `plugins/<plugin_name>/agents/`. Confirm exact tool names before
restricting `tools`; invalid names cause failures. Keep permissions inherited or
scoped.
[Native subagents](https://antigravity.google/docs/subagents),
[AGY background tasks](https://antigravity.google/docs/cli/subagents)

`agy --help` lists `--effort low|medium|high` at session level only, with no
per-child counterpart. Report tier or default effort when the child interface
exposes no effort control. Prefer the Gemini route here; the presence of Claude
alternatives in `agy models` does not make them required.

For these workflow skills, the native global discovery root is
`~/.gemini/config/skills/<name>/`. A fresh AGY session confirmed discovery there;
the attempted parent-directory `skills.json` registration did not expose them.
[Skill locations](https://antigravity.google/docs/skills)
