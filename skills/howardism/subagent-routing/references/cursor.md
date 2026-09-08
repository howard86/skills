# Cursor CLI subagent reference

Reviewed 2026-09-08 against Cursor Agent CLI 2026.08.25-3e8eec8. The running harness
is Cursor even when its selected model is GPT, Gemini, Claude, or Grok. Grok 4.6
inside Cursor uses this reference, not the standalone Grok Build reference.

## Suggested routing

| Role | Grok route: local CLI model ID | Escalation |
| --- | --- | --- |
| Narrow search, extraction, mechanical groups | `cursor-grok-4.6-low` | `cursor-grok-4.6-medium` |
| Implementation, tests, ordinary review, commit grouping | `cursor-grok-4.6-medium` | `cursor-grok-4.6-high` |
| Difficult diagnosis, high-risk review, arbitration | `cursor-grok-4.6-high` | `cursor-grok-4.6-xhigh` |

Use these Grok routes by default for delegated work unless the user selects
another model. These are workflow suggestions, not benchmark claims. Standard
speed is the starting choice; the live catalog also lists a `-fast` variant for
each effort. Select Fast explicitly when the task warrants its different cost.
Cursor documents low, medium, high, and xhigh effort, with plan-dependent defaults.
[Grok 4.6 parameters and pricing](https://cursor.com/docs/models/grok-4-6)

Non-Claude alternatives remain available: `gpt-5.6-luna-low` for narrow work,
`gpt-5.6-terra-medium` for implementation, and `gpt-5.6-sol-high` or
`gpt-5.6-sol-xhigh` for difficult judgment. `composer-2.5` is another local
implementation option. Verify exact IDs with `cursor-agent --list-models` (or
`agent --list-models`). Availability in the list does not prove remaining quota.

## Runtime adapter

Use Cursor's exposed `Task`/subagent interface. Native custom definitions live in
`.cursor/agents/` or `~/.cursor/agents/`; compatible Claude/Codex definitions may
also load. Pass the full assignment because children receive fresh context.
If this session lacks delegation, follow the router's unsupported-route rule.

Keep the two model representations separate:

- CLI launch flag: `--model cursor-grok-4.6-medium` uses the local catalog alias.
- Custom subagent frontmatter: `model: grok-4.6[effort=medium,fast=false]` uses
  the base model and Cursor's parameter syntax. Use `low`, `high`, or `xhigh`
  for the other roles above. Do not copy standalone Grok or Codex effort flags.

For example, a custom read-only scout definition can start with:

```yaml
---
name: grok-scout
description: Research a bounded question and return evidence without editing files.
model: grok-4.6[effort=low,fast=false]
readonly: true
---
```

Put the assignment contract in the body. For an implementation worker omit
`readonly: true` and explicitly assign its writable files. `is_background` is
optional. Custom agents otherwise inherit the parent model. Policy or plan
restrictions can substitute a model; inspect actual resolution and never treat
a definition or the worker's self-report as proof of what ran.
[Custom subagent configuration](https://cursor.com/docs/subagents)

Prepare an explicit worktree when isolation is needed; custom agent fields do
not establish automatic isolation. Project `AGENTS.md`, `CLAUDE.md`, and
`.cursor/rules` do not change the running harness.
[Cursor CLI rules](https://cursor.com/docs/cli/using)

## Persistent local setup

When asked to change the default parent model, use interactive `/model` to select
Grok 4.6 and its effort/speed variant. Let Cursor write its model metadata in
`~/.cursor/cli-config.json`; do not synthesize the display object. A command-line
model selection is suitable for an explicit run, but inspect saved settings
afterward rather than assuming it cannot persist.
[CLI configuration](https://cursor.com/docs/cli/reference/configuration)

Built-in Explore has its own setting. In CLI Settings, use **Explore Subagent
Model** and select Grok 4.6 when requested. In the installed build this writes
`subagentModels.explore: "grok-4.6"`, which takes precedence over the legacy
`exploreSubagentModel`. The legacy field only accepts `default` or `inherit`;
never assign it a model ID. These keys were verified from the installed CLI
schema and Settings implementation, not a published configuration schema.

The Explore picker does not establish per-child effort or speed. Do not assume
parent `modelParameters` control Explore. Use an explicit custom subagent when
those settings matter, then inspect runtime resolution. Recheck this behavior
after CLI updates. Preserve unrelated settings and spend limits.

The shared skills are linked at `~/.cursor/skills/{subagent-routing,
implement-with-subagent,commit-with-subagent}`. New sessions discover their
metadata and read the selected harness reference on invocation.

Local setup check on 2026-09-08: a read-only Grok 4.6 medium CLI request completed
and discovered all three skills. Cursor persisted the parent selection as
`grok-4.6` with `effort=medium,fast=false`; built-in Explore was configured as
`subagentModels.explore="grok-4.6"`. The check proves parent access and skill
discovery, not an independently confirmed child model or Explore effort/speed.
