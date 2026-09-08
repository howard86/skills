---
name: perf-review
description: Fan out the perf-* angle skills as parallel subagents over a target and merge their findings into ranked, measurable improvement suggestions.
disable-model-invocation: true
---

# Perf Review

Performance is considered during review, not deferred. The deliverable is ranked hypotheses, each tied to the measurement that would prove it (source: [Dean & Ghemawat's Performance Hints](https://abseil.io/fast/hints.html)).

## Process

### 1. Pin the target

Whatever the user named — files, dirs, functions — wins. Otherwise, the diff `git diff <fixed-point>...HEAD` (three-dot, against the merge-base with `main`). If that's empty, ask.

Also capture any hotness evidence offered: a profile, benchmark output, or the user's own statement of what's hot.

Confirm the target is non-empty before going further — a missing target should fail here, not inside four subagents.

### 2. Fan out 4 parallel subagents

One per angle, each `general-purpose` with an explicit `model` (default `opus`; a "with sonnet" argument overrides): perf-algorithms, perf-memory, perf-api, perf-overhead.

Each subagent's prompt: invoke its member skill and the `perf-measurement` skill by name, sweep the target, and report **every** finding with no self-filtering — thresholds apply at presentation, not detection. Per finding: file:line, the hint violated, the concrete change, a back-of-envelope cost estimate, and confidence.

### 3. Merge

- Dedupe sites flagged by more than one angle: keep the strongest framing, note the overlap.
- Invoke the `perf-measurement` skill to sanity-check the estimates.
- Rank by estimated impact ÷ effort against the hotness evidence.
- Keep the full list — ranking is not filtering.

### 4. Report

Ranked suggestions, each: location, change, estimated win, and the exact measurement (benchmark or profile command) that would prove it. State plainly: every suggestion is a hypothesis until that measurement runs.

### 5. Ship — only when the user asks for it

The default deliverable is the ranked report. When the user asks for the findings implemented ("create atomic commits and PR for each angle"), each angle becomes its own branch and PR, and every one is gated on `perf-measurement`: benchmark before and after, verdict in the PR body. An angle whose measurement does not move stays unshipped and is reported as a refuted hypothesis — a PR without a benchmark is an unproven claim, not a perf fix.

## Boundaries

Review by default; edits only on the ship branch above. Distinct from `code-review` (standards/spec) and `simplify` (quality) — this axis is runtime cost.
