---
name: blindspot
description: Diagnosis-only pass that surfaces the user's unknown unknowns for a stated goal and suggests sharper prompts for the follow-up work. Use when the user says "blindspot pass", "what am I missing", "help me figure out my unknown unknowns", or "help me prompt you better" about a goal, plan, or investigation.
disable-model-invocation: true
---

# Blindspot Pass

The user states a goal and what they already know or suspect. The deliverable is ranked blindspots — not fixes, not edits. Do not build or change anything.

## Process

1. **Restate the goal** in one line, including the success metric if the user gave one (latency target, PnL, correctness bar).
2. **Explore what the goal actually touches** — read the relevant code paths, configs, data, and recent history end to end. Blindspots live in the gap between what the user described and what the system actually does.
3. **Hunt in the standard hiding places**, checking each against the goal:
   - Assumptions stated as facts (clocks, units, ordering, "this side is fast").
   - Paths not exercised: error/retry branches, the other exchange/venue/symbol, restart behavior.
   - Measurement validity: is the metric measuring what the user thinks (net vs gross, wall vs server time, sampled vs full)?
   - Interactions with adjacent systems the prompt didn't mention (sibling callers, shared state, CI, prod config drift).
   - Scale/time effects invisible in short runs: unbounded growth, drift, warm-up bias.
4. **Report ranked by leverage** — most consequential first. For each: the blindspot, the evidence (file/line, log line, config key), and what it would change about the plan. Tag confidence. Report every finding; rank rather than filter.
5. **Prompt suggestions**: end with 2–3 concrete follow-up prompts the user could run next, each scoped to one blindspot, with the context the prompt should include (paths, constraints, acceptance criteria).

## Boundaries

Diagnosis only — no edits, no fixes, no PRs, even for obvious one-liners; name them as findings instead. Distinct from `grilling` (which interrogates a plan the user wrote); blindspot investigates the system to find what the user didn't think to ask.
