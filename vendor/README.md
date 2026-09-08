# Vendored skills

Read-only copies of third-party skills that otherwise exist only inside an installed
Claude Code plugin. Vendoring them means the documents survive uninstalling the plugin,
and that changes upstream show up as a reviewable diff rather than silently.

Regenerate with [`scripts/vendor-skills.sh`](../scripts/vendor-skills.sh); the manifest
lives at the top of that script. Every skill carries a `SOURCE.md` naming the repo, the
exact commit, and the path it came from.

**Don't edit anything here** — the next run overwrites it. Send changes upstream.

## Not a bucket

`vendor/` sits outside `skills/` on purpose. `scripts/link-skills.sh` walks `skills/`,
so anything filed there gets symlinked into `~/.claude/skills` and `~/.agents/skills` —
which for these would mean every skill installed twice, once bare and once namespaced by
its plugin. Nothing in `vendor/` belongs in `README.md` or `.claude-plugin/plugin.json`
either; the plugin ships the promoted buckets, not other people's work.

## What vendoring does and doesn't buy

It copies the skill *documents*, not the plugins' runtimes. A vendored skill that drives
a CLI still describes a tool that isn't there once its plugin is gone. `ponytail` and
`skill-creator` are prose plus scripts and stand alone.
