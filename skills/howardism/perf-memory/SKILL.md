---
name: perf-memory
description: Cut allocation and memory-representation costs — pre-sizing, copy avoidance, object reuse, compact layouts, indices over pointers. Use when the user mentions allocations, GC pressure, cache misses, or memory bloat, or wants a data structure slimmed.
---

# Perf Memory

## Process

1. Establish the hot path — or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding by invoking the `perf-measurement` skill.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Allocation in a hot loop** — per-iteration allocation: new objects, growing appends, boxing, closures. → hoist one buffer/object out and reuse it across iterations.
- **Unsized growth** — a container grown element-by-element when the final size is knowable up front. → reserve/pre-size before filling.
- **Defensive copy** — data copied where a view would do; owned copies crossing API boundaries. → pass views/slices/borrows; move instead of copy when handing off ownership.
- **Pointer-rich representation** — nested maps of maps, linked structures, one heap object per element. → flatten: contiguous arrays, a single map with a composite key, struct-of-arrays where iteration dominates.
- **Fat fields** — 8-byte fields holding small ranges, hot and cold fields interleaved, padding from careless ordering. → order fields by size, use the smallest sufficient types, split rarely-touched cold fields into a side structure.
- **Pointers where indices do** — full pointers linking elements of an array you already own. → store integer indices into the array instead.

In GC languages the same costs surface as GC pressure; the fixes — reuse, pre-size, unbox — are unchanged.
