---
name: perf-render
description: "Cut UI render-path costs: unnecessary re-renders and rebuilds, work inside render or build functions, expensive paint effects, unstable memo and query keys, unbatched state updates. Use when the target is a React, React Native, Next.js, Flutter, or other declarative UI, or when the user mentions jank, dropped frames, or slow interactions."
---

# Perf Render

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Coarse change notification**: one store, context, or ChangeNotifier that every widget subscribes to. Fix: split it and subscribe narrowly; 1,308 rebuilds per drag became 3.
- **Work inside render or build**: parsing, detection, sorting, or formatting of large input executed on every render. Fix: compute once outside, memoize on the inputs, or move it to a worker; 326 to 373 ms per build became 70 to 84 ms.
- **Unstable identities**: inline object or array literals as memo dependencies, query keys, or props, so caches and memos never hit. Fix: build the key from stable primitives; 200 distinct query keys became 1.
- **Expensive paint**: a full-screen blur or backdrop filter, shadows on every list row, no repaint boundary around animating children. Fix: remove or bound the effect, add repaint boundaries; 1,032 objects painted per tick became 23.
- **Unbatched updates**: a state write per incoming log line or frame. Fix: debounce or batch per animation frame.
- **Unbounded lists and history**: rendering every item of a growing list, holding all history in state. Fix: virtualize, cap, and page.
- **Hook or lifecycle misuse**: effects re-subscribing on every render, conditional hook order, subscriptions not torn down. Fix: stable dependencies, one subscription per mount.

Measure with the framework's own counters (rebuild and paint counts, the React Profiler, frame timing), not with CPU time alone.
