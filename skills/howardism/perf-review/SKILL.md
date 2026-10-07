---
name: perf-review
description: Fan out the perf-* angle skills as parallel subagents over a target, merge their findings into ranked, measurable hypotheses, and ship them as one benchmark-gated PR when asked.
disable-model-invocation: true
---

# Perf Review

Performance is considered during review, not deferred. The deliverable is ranked hypotheses, each tied to the measurement that would prove it (source: [Dean & Ghemawat's Performance Hints](https://abseil.io/fast/hints.html)).

## Process

### 1. Pin the target

Whatever the user named (files, dirs, functions) wins. Otherwise, the diff `git diff <fixed-point>...HEAD` (three-dot, against the merge-base with `main`). If both are empty, ask. Never choose a target yourself. Any narrowing or widening you do choose (excluding a subtree, picking a hot path inside a layer) goes in the report header, labelled as your choice.

Hotness evidence is a gate. With no profile or benchmark, either run or propose one before fan-out when the environment allows it, or label the report "static review, ranked by structure, not by hotness". Either way, state the **dominant cost** of the path (database round trip, network hop, LLM call, frame budget, allocator) so workers cost micro-findings against it, not in isolation.

Capture the measurement environment once, here:

- Where benchmarks run: local, or a remote host behind a lock.
- Whether gates must run one at a time (parallel test, lint, and bench runs have crashed the machine).
- What fixtures exist: database up, seed data, bench harness.
- Which earlier perf PRs are already merged, so workers exclude them.
- The system-level yardstick, if one exists (an end-to-end benchmark, load test, replay harness, SLO, or dashboard metric), and the realistic workload.

Confirm the target is non-empty before going further: a missing target should fail here, not inside seven subagents.

### 2. Fan out

Call the Skill tool with `subagent-routing` first.

Seven angles by default: perf-algorithms, perf-memory, perf-api, perf-overhead, perf-io, perf-concurrency, and perf-e2e on every run. Add perf-render when the target includes UI code (React, React Native, Next.js, Flutter, or any declarative UI). One `general-purpose` worker per angle, each with an explicit `model` (default `opus`; a "with sonnet" argument overrides).

Spawn them nameless. A named teammate reports through an idle-notification digest capped at 16,000 characters (four runs lost report text that way and recovered it from transcripts); a nameless worker's final message arrives whole. If a named worker is unavoidable, read its report with chat-history (`show <id> --last`) before stopping it.

Each brief carries:

- The target boundary and the exclusion list of already-fixed items.
- The dominant cost, and the hotness evidence or its absence.
- The measurement environment, and whether the worker may run benchmarks.
- The instruction to call the Skill tool twice, once with its angle skill and once with `perf-measurement`.
- Report **every** finding, no self-filtering: thresholds apply at presentation, not detection.
- The full report goes in the final assistant message, never in a `SendMessage`.
- Per finding: file:line, the hint violated, the concrete change, a back-of-envelope estimate against the dominant cost, and confidence.
- Findings outside the target boundary go in a separate "out of target" list. Correctness bugs noticed on the way go in a separate "bugs found en route" list, never in the perf tiers.

The perf-e2e brief differs: it calls the Skill tool with `perf-e2e`, files no per-line findings, and reports the yardstick per flow, the existing harness or the gap, and the budget.

### 3. Merge

- Dedupe by site (the same WebSocket defect once came back from three angles): keep the strongest framing, note the overlap.
- Drop items on the exclusion list or already fixed in the tree.
- Call the Skill tool with `perf-measurement` to sanity-check the estimates, using the runtime calibration it carries (exception and regex costs in managed runtimes).
- Rank by estimated impact ÷ effort against the hotness evidence. Ranking is not filtering: keep the full list.

### 4. Report

- Header: the perf-e2e yardstick per flow first, then scope as pinned (plus any narrowing you chose), evidence status (profiled, or static review), dominant cost, measurement environment.
- Ranked suggestions, each: location, change, the flow and metric it should move, estimated win, and the exact measurement command that would prove it.
- Then three sections: out of target; bugs found en route; refuted or disproved (empty at review time, filled during ship).

State plainly: every suggestion is a hypothesis until measured.

### 5. Ship, only when the user asks for it

Default shape: one integration branch, one draft PR, atomic benchmark-gated commits. Every recorded run asked for exactly this; a branch and PR per angle is the opt-in when the user says "a PR per angle".

- Call the Skill tool with `implement-with-subagent` for the build, then with `commit-with-subagent` for the commits. Push and open the PR only on the user's request.
- Prepare the integration worktree before spawning writers: a worktree-isolated worker cannot commit into another checkout, so the root integrates their diffs.
- Establish the noise floor first: an A/A run between two untouched commits (recorded drift was 5 to 8 percent). A win inside the floor is flat.
- Run gates one at a time. On a shared bench host, run one benchmark at a time behind the bench lock.
- "Measured before and after" is per commit and literal, with the numbers in the commit message. A commit whose measurement does not move is dropped and listed in the PR body under refuted hypotheses.
- After the per-commit gates and before the PR opens, call the Skill tool with `perf-e2e` on the integration branch against its base. A flow that regresses beyond the noise floor blocks the PR until the offending commit is bisected with the same harness and dropped or reworked, whatever its microbenchmark said. The verdict table (estimate, microbenchmark delta, system delta per flow) goes in the PR body.
- Land fixups before later commits that touch the same lines, or autosquash conflicts follow.
- Watch CI to completion and report the final state, not "queued".

A PR without a benchmark is an unproven claim, not a perf fix.

## Boundaries

Review by default; edits only on the ship path above. Distinct from `code-review` (standards/spec) and `simplify` (quality): this axis is runtime cost.
