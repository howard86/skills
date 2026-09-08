# Antigravity subagent reference

Reviewed 2026-09-08. Local AGY language server: 1.1.27. Apply to Antigravity/AGY,
not Gemini CLI merely because both use a `.gemini` directory.

## Suggested routing

| Role | Native subagent tier | Related locally listed session model |
| --- | --- | --- |
| Search, extraction, mechanical groups | `flash` | `gemini-3.8-flash-low` |
| Bounded implementation, tests, commit grouping | `flash`; raise to `pro` when judgment warrants | `gemini-3.8-flash-medium` |
| Complex implementation, high-risk review, arbitration | `pro` | `gemini-3.1-pro-high` |

These are role recommendations; `agy models` returned those IDs on this account.
Refresh with that command or the model picker before relying on another account.
The CLI session model and effort flags are **not** proof that a child accepts the
same fields. A tier may resolve to a different concrete model: record the child's
reported resolution, or say it is unknown. Do not promise that `flash` means 3.8.

## Runtime adapter

Use `invoke_subagent` and, when available, `define_subagent`. The documented
custom definition supports `model: inherit | flash | pro`; select only values
accepted by the live interface. A child starts with a fresh conversation.
Workspace choices include `inherit`, `branch`, and `share`; choose according to
the actual tool schema, and verify repo/base/path. Otherwise prepare a worktree
explicitly. Calls are asynchronous: retain the child handle and await its result.

Custom definitions are discovered under `.agents/agents/` and
`~/.gemini/config/agents/`. Check exact tool names before restricting a definition's
tool list; invalid names can cause failures. Keep permissions inherited/scoped.
[Native subagents](https://antigravity.google/docs/subagents),
[AGY background tasks](https://antigravity.google/docs/cli/subagents)

`agy --help` lists session `--effort low|medium|high`; do not translate this into
an undocumented per-child effort parameter. Report tier/default effort if the
child interface exposes no effort control. Prefer the Gemini route here; the
presence of Claude alternatives in `agy models` does not make them required.

For these workflow skills, the native global discovery root is
`~/.gemini/config/skills/<name>/`. A fresh AGY session confirmed discovery there;
the attempted parent-directory `skills.json` registration did not expose them.
[Skill locations](https://antigravity.google/docs/skills)
