---
name: afk-issue-loop
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/issue-loop.sh *)
description: Burns down a GitHub issue backlog unattended — one branch and PR per issue, opened for human review, never merged. Bundles a resumable headless runner, and drives an interactive /loop or cron iteration. Use when the user wants to run an issue loop, work a backlog into PRs, or process ready-for-agent issues AFK.
---

# AFK Issue → PR Loop

Drive a GitHub issue backlog to one branch + one PR per issue, unattended. Work
lands as **PRs for human review, never merges**. Read [GOTCHAS.md](GOTCHAS.md)
before the first run of this loop in any repo — it is where past runs broke.

## Quick start

**Headless (true unattended, resumable):** the runner is bundled beside this
file, so resolve it against the skill's own directory — `${CLAUDE_SKILL_DIR}` in
Claude Code — never against the cwd, which is the target repo.
```bash
# auto-detects REPO from the current gh-linked repo
LABEL=ready-for-agent ${CLAUDE_SKILL_DIR}/scripts/issue-loop.sh   # one PR per labelled issue
DRY_RUN=1 ${CLAUDE_SKILL_DIR}/scripts/issue-loop.sh               # list only, change nothing
LIMIT=1 ${CLAUDE_SKILL_DIR}/scripts/issue-loop.sh                 # just the first pending issue
```
Its header block documents every env knob and the `done.txt` resume file; read
it there rather than trusting a copy here.

**Interactive (`/loop`):** run the protocol below per iteration, self-paced or
on a cron. Use this when you want to watch each issue and intervene.

## Pre-flight (do this BEFORE arming the loop)

Settle all four before arming. The first is where most runs die — GOTCHAS #1 has
the failure mode and why the prompt fires at all:

1. **PR/push is pre-authorized** — an allow rule for the *absolute* path of your
   VCS CLI (e.g. `/opt/homebrew/bin/gh pr create`, `git push`), or the headless
   script, which runs with `--dangerously-skip-permissions`.
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
4. **IMPLEMENT** — only what the issue asks; surgical changes; regenerate code
   if you touch schemas/protos/specs.
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
- Self-pacing wait: ~270s while actively watching CI, 1200s+ when idle-polling.
  Keep the active wait just under 300s — that is the 5-minute prompt-cache TTL,
  so a wait landing on it pays a full cache miss for no extra progress. (A
  session on the 1-hour TTL is free of this; 270s costs nothing either way.)
- Set auto-expiry (e.g. 7 days); `durable:false` crons die on restart — re-arm
  at session start, or prefer the headless script's `done.txt` for persistence.

See [GOTCHAS.md](GOTCHAS.md) for the eight landmines past runs hit.
