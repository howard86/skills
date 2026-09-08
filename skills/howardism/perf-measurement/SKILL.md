---
name: perf-measurement
description: Estimate and measure performance — back-of-envelope costing from a latency-numbers table, microbenchmarks, profiling. Use when the user asks how expensive code is, wants a benchmark or profile, a perf claim needs evidence, or a perf-* finding needs costing.
---

# Perf Measurement

Estimates rank work; measurements close it. No perf claim is done without measured output.

## Process

1. **Estimate first** — cost per op × ops per unit of work × frequency, compared against the budget. Outside ~100× the budget: drop it. Within ~10×: measure.
2. **Pick the instrument** — a microbenchmark for a known hot function; a profile when the distribution is unknown. A flat profile means distributed 1% costs — hunt category-wide fixes (allocation, logging) rather than one hotspot.
3. **Run or propose the measurement.**
4. **Report estimate vs. measured.**

## Reference: latency numbers (orders of magnitude)

- L1 cache hit — ~0.5–1 ns
- Branch mispredict — ~3–5 ns
- L2 cache hit — ~4–7 ns
- Uncontended mutex lock/unlock — ~20 ns
- Main-memory reference — ~60–100 ns
- Heap allocation — ~25–100 ns (plus amortized GC in managed runtimes)
- Compress 1 KB — ~2–3 µs
- Read 1 MB sequentially from memory — ~10–50 µs
- SSD random read — ~20–100 µs
- Same-datacenter round trip — ~200–500 µs
- Read 1 MB from SSD — ~200 µs–1 ms
- Disk seek — ~2–10 ms
- Cross-region round trip — ~50–150 ms

## Reference: tools by ecosystem

- **CPU profiling** — Linux `perf`, pprof (Go), py-spy (Python), `node --cpu-prof` / 0x (Node), async-profiler (JVM), Instruments (macOS).
- **Microbenchmarks** — Google Benchmark (C++), `go test -bench`, pytest-benchmark, Criterion (Rust), JMH (JVM), hyperfine (any CLI).
- **Allocation/heap** — pprof alloc profiles, memray, Chrome DevTools heap profiler.

## Reference: discipline

- Benchmark the realistic input distribution, not the toy case.
- Report variance — min-of-N or a confidence interval.
- Watch for dead-code elimination hollowing out a microbenchmark.
- Profile the build mode you ship.
