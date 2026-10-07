---
name: perf-overhead
description: "Strip incidental hot-path overhead: logging, stats and metrics collection, and indirection the optimizer can't see through. Use when a hot loop carries logging or metrics, a profile shows time outside the real work, or inner-loop calls hide behind dynamic dispatch."
---

# Perf Overhead

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Logging in the hot loop**: per-iteration log calls, including disabled-level ones that still format or allocate, and the enabled-check itself (load plus compare, sometimes a formatting call) repeated inside nested loops. Fix: lift out of the loop and log aggregates once; make the disabled case cost one predictable branch and zero formatting; evaluate the check once outside the loop and pass the boolean down.
- **Always-on stats**: counters/histograms updated on every operation, often on contended atomics. Fix: drop stats nobody reads; sample high-frequency ones 1-in-N; aggregate thread-locally and flush.
- **Opaque indirection in the inner loop**: virtual/dynamic dispatch, function pointers, megamorphic call sites in the hottest few lines. Fix: monomorphize the inner loop: concrete types, direct calls; in JIT runtimes keep hot call sites monomorphic and object shapes stable.
- **Cold code bulking the hot function**: error/slow-path handling inline in the hot function, wrecking inlining and instruction cache. Fix: extract the slow path into its own function; keep the hot path small and branch-predictable.
- **Result or status wrapper on the success path**: error-carrying return types, exception machinery, or status objects constructed on every call of a routine that almost never fails. Fix: a plain return for the hot routine, with the detailed error form behind a slow path. Calibration: measure before claiming, exception and regex costs in Dart, JavaScript, and the JVM came in 10 to 50 times below C++ intuition in recorded runs.
- **Hand-optimization without evidence**: unrolling or aliasing tricks applied on faith. Fix: only with a benchmark showing the win (call the Skill tool with `perf-measurement`).

This angle trades clarity for speed most directly: apply only where hotness is evidenced.
