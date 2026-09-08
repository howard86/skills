---
name: perf-overhead
description: Strip incidental hot-path overhead — logging, stats and metrics collection, and indirection the optimizer can't see through. Use when a hot loop carries logging or metrics, a profile shows time outside the real work, or inner-loop calls hide behind dynamic dispatch.
---

# Perf Overhead

## Process

1. Establish the hot path — or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding by invoking the `perf-measurement` skill.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Logging in the hot loop** — per-iteration log calls, including disabled-level ones that still format or allocate. → lift out of the loop and log aggregates once; make the disabled case cost one predictable branch and zero formatting.
- **Always-on stats** — counters/histograms updated on every operation, often on contended atomics. → drop stats nobody reads; sample high-frequency ones 1-in-N; aggregate thread-locally and flush.
- **Opaque indirection in the inner loop** — virtual/dynamic dispatch, function pointers, megamorphic call sites in the hottest few lines. → monomorphize the inner loop: concrete types, direct calls; in JIT runtimes keep hot call sites monomorphic and object shapes stable.
- **Cold code bulking the hot function** — error/slow-path handling inline in the hot function, wrecking inlining and instruction cache. → extract the slow path into its own function; keep the hot path small and branch-predictable.
- **Hand-optimization without evidence** — unrolling or aliasing tricks applied on faith. → only with a benchmark showing the win (invoke the `perf-measurement` skill).

This angle trades clarity for speed most directly — apply only where hotness is evidenced.
