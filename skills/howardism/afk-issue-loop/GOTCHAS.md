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

**Validated recipe:** the cleanest isolation is a **throwaway clone** of the dev
DB per migration batch — clone it, repoint the worktree's DB env (which may be
*discrete* fields like `DATABASE_NAME`, not just one `DATABASE_URL`), implement +
test, then drop the clone or surgically revert (drop the new objects + delete the
`_prisma_migrations` row) before the next branch. Watch for repos where
`prisma migrate dev` can't run at all: a pre-existing `CREATE INDEX CONCURRENTLY`
migration fails the in-transaction shadow-DB replay (Prisma P3006). There,
generate SQL with `migrate diff` (hand-qualify the schema, e.g. `"trade"."…"`)
and let prod apply it via `migrate deploy` (no shadow).

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

**Two operational follow-ups:** (a) treat the agent label as a *buildable
frontier* — it should mean "buildable on the current base," not just
"well-specified"; promote a blocked slice's label only once its blocker's PR
merges. (b) Independently-clean PRs can still conflict *with each other* on shared
files (a nav array, a contracts index, the server entrypoint); when you spot it,
note the expected conflict + a suggested merge order in the PR body instead of
silently shipping a landmine.

## 7. Non-durable crons die on restart

Session-scoped (`durable:false`) cron jobs vanish when the session restarts, so
the loop silently stops.

**Avoid:** re-arm at session start, or prefer the headless script — its
`done.txt` makes progress survive restarts without a live session.

## 8. Re-processing already-shipped issues

An issue stays open and labelled until its PR *merges* — `Closes #N` only fires on
merge. A picker keyed off "open + labelled" therefore re-grabs every issue that
already has an open PR, burning a full budget cycle each time before the
duplicate-PR check (or a stale claim comment) skips it. `done.txt` only guards
within one machine's headless runs; interactive runs have no such state.

**Avoid:** at PICK, skip any issue that already has an open PR closing it or a
`feature/issue-<N>-*` branch on the remote — check *before* implementing, not at
PR-create time.
