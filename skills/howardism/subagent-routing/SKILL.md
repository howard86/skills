---
name: subagent-routing
description: Resolve the running harness, supported model and reasoning settings, and ownership contract before delegating work. Use with implementation, commit preparation, research, or independent review through subagents in Claude Code, Codex, Antigravity, Cursor CLI, or Grok Build.
---

# Subagent Routing

Read this entrypoint before spawning a subagent. It is the shared subagent
reference; read only the harness branch that applies, then the common contract.

## Identify the running harness

Use the current session's explicit runtime identity and live tool descriptions.
The model provider, installed binaries, environment variables inherited from a
parent shell, and the directory containing this skill do not establish identity.
Several harnesses import one another's skills and instructions.

| Running session | Corroborating native interface; check its live schema | Read |
| --- | --- | --- |
| Claude Code | `Agent` with Claude subagent types | [Claude reference](references/claude.md) |
| Codex desktop or CLI | `collaboration.spawn_agent` or the exposed Codex `spawn_agent` tool | [Codex reference](references/codex.md) |
| Google Antigravity, including AGY CLI | `invoke_subagent`; optional `define_subagent` | [Antigravity reference](references/antigravity.md) |
| Cursor CLI / Cursor Agent | Cursor `Task` delegation and Cursor agent metadata | [Cursor reference](references/cursor.md) |
| Grok Build | `spawn_subagent` and Grok session metadata | [Grok reference](references/grok.md) |

Tool names are corroboration, not unique identifiers. If identity is ambiguous,
inspect runtime metadata/help without starting another session; ask for the
harness only if that leaves the route unresolved. If native delegation is absent,
report that limitation and do useful root work within the requested scope. An
explicit subagent requirement remains incomplete until a supported worker runs.

## Resolve the assignment

1. Read [the common contract](references/common.md) and the selected harness
   reference. Apply user-selected models and constraints before recommendations.
2. Check the current runtime's advertised models, effort values, tools, and
   permissions. The dated recommendations are starting points, not an allowlist
   or proof of account access. Refresh when unavailable or contradicted by the
   live session; do not change account defaults just to inspect availability.
3. Match the role: scout, implementer/committer, or reviewer/arbiter. Prefer the
   least costly available choice that reliably meets the quality bar. Improve an
   inadequate brief before raising effort or escalating to the next role tier.
4. State the selected harness, requested model/effort, absolute workspace, scope,
   and result contract in the brief. After launch, distinguish runtime-confirmed
   settings from requested settings; report any substitution or unknown resolution.

These skills have no shared Claude dependency. Claude's native branch recommends
Claude models; the other branches recommend non-Claude models. If the user forbids
Claude models, preserve that constraint even in Claude Code: use only an already
available, explicitly authorized non-Claude delegation integration, or report
the native-route limitation. Do not silently launch another CLI, invent model
aliases, bypass permissions, or reconfigure a provider as a fallback.

## Several harnesses running together

Native child limits and index ownership do not coordinate unrelated sessions.
Before a write handoff, establish exclusive ownership with the other active
writers, or use a distinct worktree and branch at an explicit base commit. Each
writer owns its files; one session owns each git index and publication step.
An existing rebase/merge or changing HEAD is another session's work until proven
otherwise. Keep its checkout intact. Never infer ownership from a clean status
or remove another session's git lock.
