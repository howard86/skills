---
name: afk-issue-loop
description: Autonomously burns down a GitHub issue backlog into one PR per issue — pick a ready issue, claim it race-safely, branch off the base, implement within scope, run the repo's verify gates, and open a PR for human review (never merging or touching the base branch). Bundles a resumable headless runner (claude -p, worktree-isolated, budget-capped) and documents the /loop + cron orchestration paths. Use when the user wants to run an AFK/unattended issue loop, batch-process ready-for-agent issues, burn down a backlog into PRs, or says "loop the issues", "process the backlog", or "run the issue loop".
---

# AFK Issue → PR Loop

Drive a GitHub issue backlog to one branch + one PR per issue, unattended. Work
lands as **PRs for human review, never merges**. Read [GOTCHAS.md](GOTCHAS.md)
before the first run of this loop in any repo — it is where past runs broke.

## Quick start

**Headless (true unattended, resumable):**
```bash
# auto-detects REPO from the current gh-linked repo
LABEL=ready-for-agent scripts/issue-loop.sh        # one PR per labelled issue
DRY_RUN=1 scripts/issue-loop.sh                    # list only, change nothing
LIMIT=1 scripts/issue-loop.sh                      # just the first pending issue
```
Knobs (all optional, env vars): `REPO LABEL MODEL MAX_BUDGET_USD LIMIT DRY_RUN
SKIP_PR BASE_BRANCH ENV_FILES BOOTSTRAP_CMD DBUP_CMD WORKTREE_DIR STATE_DIR`.
Completed issues are recorded in `STATE_DIR/done.txt` and skipped next run.

**Interactive (`/loop`):** run the protocol below per iteration, self-paced or
on a cron. Use this when you want to watch each issue and intervene.

## Pre-flight (do this BEFORE arming the loop)

The single most common failure is the loop doing all the work, then **stalling
at PR creation** on a permission prompt. Settle these first:

1. **PR/push is pre-authorized.** Either add an allow rule for the *absolute*
   path of your VCS CLI (e.g. `/opt/homebrew/bin/gh pr create`, `git push`), or
   run the headless script (it uses `--dangerously-skip-permissions`).
2. **Base branch + label** are correct (`BASE_BRANCH`, `LABEL`).
3. **Verify command** for this repo is known (lint / type-check / test).
4. **Bootstrap / DB** state: if the repo needs install, codegen, or a local DB
   to build, set `BOOTSTRAP_CMD` / `DBUP_CMD` (or do it once by hand).

## Protocol (per issue)

1. **PICK** — lowest-numbered open issue matching the label, **that is actually
   buildable** and **not already shipped**. Ready ≠ buildable: skip issues whose
   scaffolding/migration lives in an unmerged PR (GOTCHAS #6). Already shipped:
   skip any issue that already has an open PR closing it or a
   `feature/issue-<N>-*` branch on the remote — an issue stays open until its PR
   *merges*, so a re-run will otherwise redo finished work (GOTCHAS #8).
2. **CLAIM** (race-safe) — post a timestamped comment `Claiming via loop at
   <UTC>`; re-read comments after posting; if another claim is within the dedup
   window (~6h), skip to the next issue. Headless single-runner: `done.txt` is
   the equivalent guard.
3. **BRANCH** — `git checkout -B feature/issue-<N>-<slug> origin/<base>` off a
   fresh fetch. Never work on the base branch.
4. **IMPLEMENT** — only what the issue asks; follow the repo's CLAUDE.md /
   conventions; surgical changes; regenerate code if you touch schemas/protos/specs.
   Commit as **atomic Conventional Commits** — one self-contained logical change
   per commit (e.g. schema → API → web), not a single mega-commit.
5. **VERIFY** — run the repo's lint / type-check / test; fix what you broke. If
   it can't be made green honestly, comment the blocker and **stop** — don't
   force past hooks.
6. **SHIP** — push (let pre-push hooks run); open a PR with `Closes #<N>` and a
   **review-ready summary** (never a one-liner): `## What`, `## Decisions` — call
   out every judgment call / spec ambiguity you resolved and ask the reviewer to
   sanity-check it, plus any expected merge conflict with a sibling PR on shared
   files — and `## Verification` — which lint/type/test gates you ran, *and*
   anything you could not verify (e.g. UI not visually checked). Never merge,
   force-push, or touch the base branch.
7. **EXIT** — if the issue is satisfied/infeasible/under-specified, make no
   commits and label it a poison-pill (`claude-blocked` / HITL) so it isn't
   retried forever. When no buildable issues remain, stop cleanly.

**Batch ordering:** when the backlog mixes schema/migration issues with plain
ones, take the **non-migration issues first** (no DB state to manage), then the
migration-bearing ones **one at a time** — never interleave two migrations
(GOTCHAS #2).

## Cadence (for recurring runs)

- Match cron interval to issue **arrival** rate, not work duration. A backlog
  that empties in one tick does not need a 5-minute cron — that wastes ticks and
  burns prompt cache. Poll every 30–60 min for slow arrival.
- **Don't stack** sub-5-minute crons (they cause claim races; see GOTCHAS #5).
- Self-pacing wait: ~270s while actively watching CI (stays in prompt cache),
  1200s+ when idle-polling. Never 300s.
- Set auto-expiry (e.g. 7 days); `durable:false` crons die on restart — re-arm
  at session start, or prefer the headless script's `done.txt` for persistence.

See [GOTCHAS.md](GOTCHAS.md) for the eight landmines past runs hit.
