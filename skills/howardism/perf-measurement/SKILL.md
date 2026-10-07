---
name: perf-measurement
description: "Estimate and measure performance: back-of-envelope costing from a latency-numbers table, microbenchmarks, profiling, noise floors. Use when the user asks how expensive code is, wants a benchmark or profile, a perf claim needs evidence, or a perf-* finding needs costing."
---

# Perf Measurement

Estimates rank work; measurements close it. No perf claim is done without measured output.

## Process

1. **Estimate first**: cost per op × ops per unit of work × frequency, against the budget AND against the dominant cost of the path (database round trip, network hop, LLM call, frame budget). A micro-cost below ~1% of the dominant cost is reported as negligible, not ranked. Outside ~100× the budget: drop it. Within ~10×: measure.
   - Calibrate: estimates ported from C++ intuition run 10 to 50 times too high for exceptions, regex matching, and small allocations in managed and JIT or AOT runtimes (a Dart JSON decode throwing on a non-JSON line measured 0.37 µs). When the runtime is managed, measure a 10-line microbenchmark before ranking such an item.
2. **Pick the instrument**: a microbenchmark for a known hot function; a profile when the distribution is unknown. Playbook for a flat or unclear profile:
   - Many 1% wins add up; hunt category-wide fixes.
   - Find loops near the top of the call stack (flame graph).
   - Look for structural changes higher in the stack rather than micro-optimizations.
   - Replace overly general code with a specialized implementation.
   - Take an allocation profile and pick off the top allocator.
   - Gather hardware-counter profiles for cache-miss rates.
3. **Establish the noise floor before any before/after claim**: run the benchmark twice on the same commit (A/A), or between two untouched commits, and record the drift. A change inside the drift is flat. Recorded drift on a dedicated bench host was 5 to 8%.
4. **Run or propose the measurement.** State the environment: build mode shipped, host, pinned CPU, one benchmark at a time behind the host's lock when shared, gates run serially (parallel test, lint and bench runs have crashed a laptop).
5. **Report estimate vs. measured**, with min-of-N or a confidence interval. A worker that measured nothing says so in its first line.

## Reference: latency numbers (orders of magnitude)

- L1 cache reference: ~0.5 ns
- Branch mispredict: ~5 ns
- L2 cache reference: ~3 to 7 ns
- Mutex lock/unlock, uncontended: ~15 to 20 ns
- Main memory reference: ~50 to 100 ns
- Heap allocation: ~25 to 100 ns (plus amortized GC in managed runtimes)
- Compress 1 KB (Snappy): ~1 to 3 µs
- Read 4 KB randomly from SSD: ~20 µs
- Round trip within the same datacenter: ~50 to 500 µs
- Read 1 MB sequentially from memory: ~64 µs
- Read 1 MB over a 100 Gbps network: ~100 µs
- Read 1 MB sequentially from SSD: ~1 ms
- Local database round trip (loopback Postgres, trivial query): ~0.3 to 1 ms
- Disk seek: ~5 ms
- Read 1 MB sequentially from disk: ~10 ms
- Cross-region round trip (CA to Netherlands to CA): ~150 ms
- LLM API call: ~1 to 300 s (dominates any path that contains one)

## Reference: tools by ecosystem

- **CPU profiling**: Linux `perf`, pprof (Go), py-spy (Python), `node --cpu-prof` / 0x (Node), async-profiler (JVM), Instruments (macOS).
- **Microbenchmarks**: Google Benchmark (C++), `go test -bench`, pytest-benchmark, Criterion (Rust), JMH (JVM), hyperfine (any CLI).
- **Allocation/heap**: pprof alloc profiles, memray, Chrome DevTools heap profiler.
- **Database**: `EXPLAIN (ANALYZE, BUFFERS)`; pg_stat_statements or pg_stat_database deltas around a run; ORM query-log statement counts (Prisma's query event) to count statements per unit of work.
- **Rust**: Criterion with `--save-baseline before` then `--baseline before`; `cargo flamegraph` or samply; a counting allocator for allocations per tick.
- **Bun/Node**: `bun` min-of-N scripts, `node --cpu-prof`, `/usr/bin/time -l` for RSS and wall time, `curl` TTFB min-of-N for endpoints.
- **Flutter/Dart**: `flutter test` benchmark files with min-of-N; rebuild and paint counts via `debugOnRebuildDirtyWidget` and `debugOnProfilePaint`; DevTools frame timing.
- **React**: the React Profiler (commit counts, render durations), Chrome DevTools Performance panel.
- **Lock contention**: mutex contention profilers where the runtime offers them; contention lowers apparent CPU, so compare wall time.

## Reference: discipline

- Benchmark the realistic input distribution, not the toy case.
- Report variance: min-of-N or a confidence interval.
- Watch for dead-code elimination hollowing out a microbenchmark.
- Build with debug info in the shipped optimization mode; profile that binary.
- Prefer a microbenchmark that covers exactly the changed code for turnaround; confirm with the system-level number before shipping, since microbenchmarks can misrepresent whole-system behaviour.
- "Measured before and after" means per change, in the change's own commit message, not one branch-level table.
