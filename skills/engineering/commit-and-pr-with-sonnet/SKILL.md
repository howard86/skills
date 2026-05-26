---
name: commit-and-pr-with-sonnet
description: Hand an already-dirty working tree to a Sonnet subagent that splits the uncommitted changes into atomic commits with on-style messages and, on a non-default branch, pushes and opens a PR — then the parent reviews. Use when the work is already done and you want cheap commit hygiene — e.g. "split these changes into atomic commits with sonnet", "commit this with sonnet", "delegate the commits/PR to a cheaper model". Does NOT implement anything (the changes must already exist); for delegating implementation use implement-plan-with-sonnet instead.
---

# Commit and PR with Sonnet

Opus did the work; now the uncommitted diff just needs carving into clean atomic commits — a
mechanical, expensive job. Hand it to a cheaper Sonnet subagent that reads the live diff, groups
it by concern, writes on-style messages, and (on a non-default branch) pushes and opens a PR.

## When to use

**Good fit** — the work is done, the tree is dirty, and you want clean commits cheaply:
- Several logical concerns tangled in one uncommitted diff that should become separate commits.
- A finished change on a feature branch that's ready to push and PR.

**Poor fit** — keep it in the current Opus session:
- Nothing worth splitting (a trivial one-liner).
- Commit boundaries need Opus-level judgment about the work's intent.

## Preconditions the parent checks first

- **Tree must be dirty.** Run `git status`; if it's clean there is nothing to commit — no-op and report.
- **Do NOT pass `run_in_background`.** The `Agent()` call is blocking, so the parent sits idle while
  the subagent runs. The subagent shares this same git index — a background run would race it.
- Record the current branch and whether it is the remote default branch (`git symbolic-ref refs/remotes/origin/HEAD`).

## Launch the subagent

No isolation — the subagent must run in **this** worktree, because the changes only exist here as
uncommitted edits (`isolation: "worktree"` would give it a clean checkout where they don't exist).

```
Agent({
  subagent_type: "general-purpose",
  model: "sonnet",
  mode: "acceptEdits",
  prompt: <self-contained brief>,
})
```

The subagent shares the directory but NOT this conversation, so the brief is self-contained; it
reads the live diff itself rather than having it inlined. The brief tells it:

- There are uncommitted changes in this working tree — run `git status` / `git diff` to see them.
- Split into **atomic commits** by logical concern; match the repo's commit-message style (infer from `git log`).
- `git add` **specific files** — never blanket `git add -A`. Include untracked files only when they're
  clearly referenced by tracked diff hunks or live in the same source dirs; skip anything that looks
  like scratch, logs, `.env`, or credentials. If unsure, leave it untracked.
- Let hooks run; never `--no-verify`. A failed hook means nothing was committed — fix the issue and run `git commit` again.
- **Branch rule:** if `HEAD` is the remote default branch (main/master) → commit only, do NOT push or
  open a PR. Otherwise → `git push -u` then `gh pr create` (base = remote default branch). Pass explicit
  `--title` and `--body` so `gh` never drops into the interactive `$EDITOR` and hangs — title synthesized
  to cover the *set* of commits, body summarizing them. Return the PR URL.
- **PR "if possible":** only push/PR when `gh` is available and a remote is configured; otherwise stop
  after committing and report that the PR was skipped + why.
- Report the final `git log --oneline` of the new commits and the PR URL (or skip reason).

The push and `gh` steps rely on the existing permission setup; `acceptEdits` matches the sibling
`implement-plan-with-sonnet`, which runs git operations under that mode successfully. Do NOT use `bypassPermissions`.

## After the subagent returns

Review `git log` / `git show` for the new commits. Undo path: `reset --soft` if not yet pushed;
force-push if already pushed (this is the cost of the fully-hands-off push/PR choice).

## Limitations

- Same-worktree means **no isolation** — the parent must stay idle while the subagent holds the shared index.
- Review is post-hoc, not pre-merge.
- The PR step needs `gh` + a configured remote; without them it's commit-only.
- Reasoning effort can't be set per-subagent — steer it through the brief wording.
