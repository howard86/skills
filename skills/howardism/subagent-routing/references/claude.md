# Claude Code subagent reference

Regenerate these facts with `claude --version`, the `/model` picker, and the live
`Agent` tool schema in this session. Last checked against Claude Code 2.1.273.
This branch applies only when Claude Code is the running harness; a Grok or Cursor
session importing Claude instructions must use its own branch instead.

## Suggested routing

| Role | Starting choice | Escalation |
| --- | --- | --- |
| Pure tallies, fetches, narrow extraction | `haiku`; default effort | `sonnet` |
| Scoped implementation, tests, ordinary commit grouping | `sonnet`; medium where supported | `opus`, medium/high |
| Difficult design, diagnosis, high-risk review | `opus`, medium/high | `fable` only if explicitly selected/authorized and available |

Use provider-resolved aliases from the current model picker: `default`, `best`
(Fable where available, otherwise Opus), `fable`, `sonnet`, `opus`, `haiku`,
`sonnet[1m]`, `opus[1m]`, and `opusplan`. Fable resolves to Fable 5.1 and may
require usage credits, so it is not an automatic cost-saving fallback.

An alias resolves to a different version per provider, which is why the workflow
skills carry aliases rather than dated full IDs:

| Provider | Opus | Sonnet |
| --- | --- | --- |
| Anthropic API | 5 | 5 |
| Claude Platform on AWS | 5 | 4.6 |
| Amazon Bedrock | 5 | 4.5 |
| Google Cloud Agent Platform | 5 | 4.5 |
| Microsoft Foundry | 4.6 | 4.5 |

[Model and effort configuration](https://code.claude.com/docs/en/model-config)

## Runtime adapter

Use the live `Agent` schema and an available built-in general-purpose worker.
Select model per invocation when supported. The `Agent` tool exposes no `effort`
parameter, so a direct invocation inherits effort: report the inherited or default
value. An agent definition can set `effort` to `low`, `medium`, `high`, `xhigh`,
or `max`.

Model resolution runs highest first: the per-invocation `model` parameter, then
frontmatter `model` (where `inherit` selects the main conversation's model), then
the `CLAUDE_CODE_SUBAGENT_MODEL` environment default, then the main conversation's
model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, available from v2.1.257, makes
subagents ignore frontmatter `model` entirely.

Agent definitions load from five locations, highest priority first: managed
settings (organization), the `--agents` CLI flag (session, JSON), `.claude/agents/`
(project), `~/.claude/agents/` (user), and a plugin's `agents/` directory. A name
collision resolves to the higher priority.

Frontmatter worth setting for delegation hygiene: `tools` (allowlist),
`disallowedTools` (denylist, accepting `mcp__*` patterns), `permissionMode`
(`default`, `acceptEdits`, `auto`, `dontAsk`, `plan`), `maxTurns`, `skills`,
`background`, and `omitClaudeMd: true` (v2.1.271+), which gives the worker a clean
instruction surface by skipping CLAUDE.md files.
[Subagent configuration](https://code.claude.com/docs/en/sub-agents)

`isolation: worktree` is both a frontmatter field and a live `Agent` parameter. It
branches from the default branch rather than from current HEAD, so work based on
any other branch needs the worktree prepared explicitly and its absolute path
passed. A worktree with no changes is cleaned up automatically, Bash and
PowerShell commands stay inside it, and git commands redirected at the main
checkout are prevented. Preserve recoverable worker artifacts until verified.

Claude models are this native adapter's recommendations, not a dependency of the
shared workflows. If Claude models are excluded, follow the router's unsupported
route handling; a `gpt-*` model name alone does not establish a working integration.
