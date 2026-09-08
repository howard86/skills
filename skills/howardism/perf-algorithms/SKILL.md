---
name: perf-algorithms
description: Find algorithmic wins in a hot path — complexity reduction, fast paths for common cases, precomputing, deferring, and caching repeated work. Use when the user wants code made faster, a loop or pipeline is slow, or the same work looks recomputed.
---

# Perf Algorithms

## Process

1. Establish the hot path — or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding by invoking the `perf-measurement` skill.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Superlinear loop** — nested iteration or repeated linear scans doing an O(N log N)/O(N) job in O(N²). → sort + single pass, hash lookup, or restructure the traversal (e.g. process in an order that makes one pass suffice).
- **Recomputed invariant** — a value computed inside a loop that doesn't change per iteration. → hoist it out; precompute at construction or startup.
- **Missing fast path** — the common case pays the general case's price. → add a cheap specialized branch for the dominant case; keep the general path as fallback.
- **Eager work** — values computed that many callers never consume. → defer: lazy-init, compute on demand.
- **Repeated expensive derivation** — the same costly result (parse, compile, hash, layout) derived from the same inputs repeatedly. → cache keyed by a fingerprint of the inputs; state the expected hit rate and the invalidation rule before adding it.
- **Generic call on the hottest line** — a hot call site paying for generality: dynamic dispatch, a generic serializer, a regex for a fixed pattern. → specialize at that call site.
