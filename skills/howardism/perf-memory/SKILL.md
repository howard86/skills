---
name: perf-memory
description: "Cut allocation and memory-representation costs: pre-sizing, copy avoidance, object reuse, compact layouts, indices over pointers. Use when the user mentions allocations, GC pressure, cache misses, or memory bloat, or wants a data structure slimmed."
---

# Perf Memory

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Allocation in a hot loop**: per-iteration allocation: new objects, growing appends, boxing, closures. Fix: hoist one buffer/object out and reuse it across iterations.
- **Unsized growth**: a container grown element-by-element when the final size is knowable up front. Fix: reserve/pre-size before filling.
- **Defensive copy**: data copied where a view would do; owned copies crossing API boundaries. Fix: pass views/slices/borrows; move instead of copy when handing off ownership.
- **Pointer-rich representation**: nested maps of maps, linked structures, one heap object per element. Fix: flatten: contiguous arrays, a single map with a composite key, struct-of-arrays where iteration dominates.
- **Fat fields**: 8-byte fields holding small ranges, hot and cold fields interleaved, padding from careless ordering. Fix: order fields by size, use the smallest sufficient types, split rarely-touched cold fields into a side structure.
- **Pointers where indices do**: full pointers linking elements of an array you already own. Fix: store integer indices into the array instead.
- **Node-based container on a hot path**: a tree or chained map allocating one node per element. Fix: a flat or batched container (vector, flat hash map, B-tree) so elements share cache lines.
- **Heap-allocated small collection**: a vector or map that is almost always 0 to 8 elements yet allocates every time. Fix: inline (small-size-optimized) storage for the common size.
- **Map or set over a small integer domain**: a map keyed by an enum or a small index, a set of small integers. Fix: an array indexed by the key; a bit vector with bitwise union and intersection.
- **Many short-lived allocations with one lifetime**: objects allocated separately but freed together. Fix: an arena, freed in one step; keep short-lived objects out of a long-lived arena.

In GC languages the same costs surface as GC pressure; the fixes (reuse, pre-size, unbox) are unchanged.
