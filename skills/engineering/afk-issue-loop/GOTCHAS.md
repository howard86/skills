# Loop gotchas — where past runs broke

Cautionary patterns distilled from real AFK issue-loop runs. They are generic;
apply judgment for the repo in front of you.

## 1. Last-step permission halt (the #1 time-waster)

The loop implements, commits, and pushes — then **stalls at `gh pr create`** on
a permission prompt (auto-mode classifiers sometimes false-positive on a CLI
that looks like a wrapper). The work is done; only the PR is missing, and a
human has to rescue it.

**Avoid:** pre-authorize before arming the loop. Add an allow rule for the
*absolute* binary path (`/opt/homebrew/bin/gh pr create`, `git push`), or run
headless with `--dangerously-skip-permissions`. Read-only `gh issue/pr list` is
usually fine; it's the write that trips.

## 2. Shared-DB migration drift across branches

When every issue branch applies its migration to one shared local database,
switching to a branch that lacks that migration file makes the ORM see
"applied-but-unfiled" drift and want to reset. Interleaving two migration-bearing
issues corrupts the local DB state.

**Avoid:** serialize migration-bearing issues (one at a time, reset between), or
give each worktree its own database. Don't interleave schema changes.

## 3. Stale editor/LSP diagnostics after a branch switch

After `git checkout -B <next> origin/<base>`, the editor model may still hold the
*previous* branch's files and report phantom errors ("X not exported", "property
does not exist") for files not even on the current branch.

**Avoid:** confirm with `git status` + a real `typecheck` run before chasing any
diagnostic. If the build is green, the diagnostic is a ghost.

## 4. Commit-message linters reject multi-line `-m`

`commitlint`-style rules (e.g. `body-max-line-length = 100`) reject long
`-m` bodies. The commit fails mid-loop.

**Avoid:** write the message to a file and `git commit -F <file>`, wrapping body
lines under the limit.

## 5. Over-scheduling causes claim races and wasted ticks

Stacking crons (e.g. a 20-min issue loop + a 1-min babysit + a 5-min poll)
produces duplicate claims (one tick claims #1, another skips it) and dozens of
idle ticks once the backlog is exhausted (one run idled 9 ticks / 45 min).

**Avoid:** one loop per backlog; match cadence to arrival rate; stop the cron
when the backlog is empty rather than letting it spin.

## 6. "Ready" ≠ buildable (DAG-blind picker)

A naive "lowest-numbered open/labelled issue" picker will grab an issue whose
scaffolding, types, or migration live in an **unmerged PR**, or that collides
with an in-flight PR on shared files (schema, contracts, server entrypoint).
The result is a conflicting PR.

**Avoid:** before claiming, check whether the issue depends on unmerged work.
If its foundation isn't on the base branch yet, skip it and pick the next one.

## 7. Non-durable crons die on restart

Session-scoped (`durable:false`) cron jobs vanish when the session restarts, so
the loop silently stops.

**Avoid:** re-arm at session start, or prefer the headless script — its
`done.txt` makes progress survive restarts without a live session.
