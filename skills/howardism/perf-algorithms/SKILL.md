---
name: perf-algorithms
description: "Find algorithmic wins in a hot path: complexity reduction, fast paths for common cases, precomputing, deferring, and caching repeated work. Use when the user wants code made faster, a loop or pipeline is slow, or the same work looks recomputed."
---

# Perf Algorithms

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Superlinear loop**: nested iteration or repeated linear scans doing an O(N log N)/O(N) job in O(N²). Fix: sort + single pass, hash lookup, or restructure the traversal (e.g. process in an order that makes one pass suffice).
- **Recomputed invariant**: a value computed inside a loop that doesn't change per iteration. Fix: hoist it out; precompute at construction or startup.
- **Missing fast path**: the common case pays the general case's price. Fix: add a cheap specialized branch for the dominant case; keep the general path as fallback.
- **Eager work**: values computed that many callers never consume. Fix: defer: lazy-init, compute on demand.
- **Repeated expensive derivation**: the same costly result (parse, compile, hash, layout) derived from the same inputs repeatedly. Fix: cache keyed by a fingerprint of the inputs; state the expected hit rate and the invalidation rule before adding it.
- **Generic call on the hottest line**: a hot call site paying for generality: dynamic dispatch, a generic serializer, a regex for a fixed pattern. Fix: specialize at that call site.
- **Bulk processing**: handling one item per operation where k items could be handled per step (decode groups of four integers at once, compare several hash bytes with one SIMD instruction, process a whole buffer then fix up the tail). Fix: process k at a time, with a scalar tail.
- **Quadratic parser or scanner**: a tokenizer, splitter, or matcher that rescans from the start on each token or on malformed input (an unclosed quote took 353 ms down to 15 ms once fixed; an HTTP parser 9 ms to 0.3 ms). Fix: single forward pass with explicit state; bound the backtracking.
