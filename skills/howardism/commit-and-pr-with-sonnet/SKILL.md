---
name: commit-and-pr-with-sonnet
description: Hand a dirty working tree to a Sonnet subagent that splits it into atomic commits and, off the default branch, pushes and opens a PR. Use when the work is done and only commit hygiene remains, on any such ask whether or not it names a model — "create atomic commits", "commit and open a PR", "create a PR with atomic commits", "atomic commits with sonnet", "delegate the commits/PR". Needs the changes to exist; to delegate the building, use implement-plan-with-sonnet.
---

# Commit and PR with Sonnet

Opus did the work; now the uncommitted diff just needs carving into clean atomic commits — a
mechanical, expensive job. Hand it to a cheaper Sonnet subagent that reads the live diff, groups
it by concern, writes style-matched messages, and (on a non-default branch) pushes and opens a PR.

## When to use

**Good fit** — the work is done, the tree is dirty, and you want clean commits cheaply:
- Several logical concerns tangled in one uncommitted diff that should become separate commits.
- A finished change on a feature branch that's ready to push and PR.

**Poor fit** — keep it in the current Opus session when commit boundaries need
Opus-level judgment about the work's intent.

## Preconditions the parent checks first

- **Tree must be dirty.** Run `git status`; if it's clean there is nothing to commit — no-op and report.
- Note whether `HEAD` is the remote default branch — that decides whether the subagent opens a PR
  (non-default) or only commits (default). The agent detects the default branch itself.

## Launch the subagent

No isolation — the subagent runs in **this** worktree, because the changes only exist here as
uncommitted edits (a worktree checkout wouldn't have them). It shares this git index, so run no git
commands of your own between launching it and its report. The harness starts subagents in the
background with no foreground option, so that restraint is the only thing keeping two writers off
one index — the skill cannot enforce it for you.

```
Agent({
  subagent_type: "sonnet-committer",
  prompt: <self-contained brief>,
})
```

The `sonnet-committer` agent (`agents/sonnet-committer.md`) is pinned to Sonnet 5 at `effort: medium`
and carries the full commit discipline — atomic commits, hook-safe staging, the branch/PR rule — so
`model`/`effort` aren't repeated here. The subagent shares the directory but NOT this conversation, so
the brief is self-contained; it reads the live diff itself rather than having it inlined:

> The working tree has uncommitted changes — commit them per your discipline, and open a PR if
> you're off the default branch.

The subagent inherits this session's permission mode — the `mode` parameter is deprecated and
ignored, so passing it buys nothing. If git/gh commands are blocked, allowlist them in the project's
`.claude/settings.json`, which scopes the grant to the commands this job actually needs. Use the
prefixed `mattpocock-skills:sonnet-committer` only where the plugin is installed; where the agent
comes from `~/.claude/agents`, the bare name is the one that resolves.

## After the subagent returns

Read `git log` and `git show` for every new commit. Done means each commit stands alone — its
message describes all and only what its diff does — and the set accounts for the whole diff you
handed over, with nothing left uncommitted. Undo path: `reset --soft` if not yet pushed;
force-push if already pushed (this is the cost of the fully-hands-off push/PR choice).

## Limitations

- Review is post-hoc, not pre-merge, and the parent gives up git for the duration (see above).
- The PR step needs `gh` + a configured remote; without them it's commit-only.
- Effort is fixed at `medium` in the agent definition.
