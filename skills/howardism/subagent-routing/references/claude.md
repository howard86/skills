# Claude Code subagent reference

Reviewed 2026-09-08 against Claude Code 2.1.263 and official documentation.
This branch applies only when Claude Code is the running harness; a Grok or Cursor
session importing Claude instructions must use its own branch instead.

## Suggested routing

| Role | Starting choice | Escalation |
| --- | --- | --- |
| Pure tallies, fetches, narrow extraction | `haiku`; default effort | `sonnet` |
| Scoped implementation, tests, ordinary commit grouping | `sonnet`; medium where supported | `opus`, medium/high |
| Difficult design, diagnosis, high-risk review | `opus`, medium/high | `fable` only if explicitly selected/authorized and available |

Use provider-resolved aliases from the current model picker. On the direct
Anthropic API, the documentation currently maps Sonnet/Opus to version 5; mappings
differ across providers. Avoid embedding dated full IDs in the workflow skills.
Fable may require usage credits, so it is not an automatic cost-saving fallback.
[Model and effort configuration](https://code.claude.com/docs/en/model-config)

## Runtime adapter

Use the live `Agent` schema and an available built-in general-purpose worker,
with the complete assignment in its prompt. Select model per invocation when
supported. Agent definitions can set `effort`; do not invent an `effort` tool
parameter when absent. In that case report inherited/default effort honestly.

Check overrides: current releases prioritize the invocation over frontmatter,
then the subagent-model environment default, then the parent. A force override
can supersede selection; older releases differ. Inspect the task's reported model.
Custom agent locations are `.claude/agents/` and `~/.claude/agents/`.
[Subagent configuration](https://code.claude.com/docs/en/sub-agents)

Use the exposed worktree option only when it targets the correct repository and
base; otherwise prepare an explicit worktree and supply its absolute path. Check
permission/isolation behavior in the active session rather than replaying old
background-job workarounds. Preserve recoverable worker artifacts until verified.

Claude models are this native adapter's recommendations, not a dependency of the
shared workflows. If Claude models are excluded, follow the router's unsupported
route handling; a `gpt-*` model name alone does not establish a working integration.
