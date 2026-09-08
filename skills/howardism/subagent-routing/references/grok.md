# Grok Build subagent reference

Reviewed 2026-09-08 against Grok Build 1.0.19 (6b38df55f6b2). Applies to the official
Grok Build CLI, not every third-party command named `grok`.

## Suggested routing

The local authenticated `grok models` list contains only **`grok-4.6`**, also the
default. Use it for all three role tiers; distinguish workloads with scoped agent
types and briefs instead of inventing cheap/mini/pro model aliases.

| Role | Choice |
| --- | --- |
| Investigation or inventories | `explore` with the listed Grok model; read-only task contract |
| Implementation, tests, commit grouping | `general-purpose` with the listed Grok model |
| High-risk review or arbitration | Independent read-only assignment on the listed model |

When quality is inadequate, narrow the task and add evidence; increase effort only
if the active model/interface advertises a supported control. The local CLI has
`--reasoning-effort` for sessions, but this does not establish a child parameter
or a particular supported value. If the same-model reviewer cannot resolve a
dispute, report it to the root rather than fabricate an escalation tier.

## Runtime adapter

Use `spawn_subagent`; retain the handle for background work and retrieve results
with the exposed output tool. Native isolation is `none` or `worktree`; `cwd` and
`isolation: worktree` are mutually exclusive. Supply a complete brief.

Check the live schema before passing model or capability overrides. The installed
guide's parameter table does not list a model argument and explicitly places
capability modes in role/definition configuration. It supports per-type model
routing through `[subagents.models]`; without overrides the parent model is
inherited. Avoid changing global routing while other sessions are active. Only
the root spawns children in the installed version.

Evidence: installed `~/.grok/docs/user-guide/16-subagents.md`, sections
“Spawning Subagents”, “Capability Modes”, “Agent Type Configuration”, and nesting
limits; [first-party source guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md).
That online guide and installed docs differ on capability arguments: use the live
tool schema, not a copied example.

Grok imports Claude skills/rules by default. Read the Grok branch even when this
reference arrived through `~/.claude/`; compatibility is not runtime identity.
[Compatibility documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces)
