---
name: perf-e2e
description: "Verify a performance change at the whole-system level: end-to-end latency percentiles under constant-rate load, throughput, resource totals, and user-facing metrics, before and after, so a microbenchmark win that regresses the system is caught. Use when a perf change is about to ship, when microbenchmarks improved but users or dashboards did not, or when the user asks for a load test, soak test, or system-level before/after."
---

# Perf E2E

## Process

Unlike the other angles, this one does not sweep code. As a review angle it inventories the system-level yardstick; at ship it runs the verification.

1. Name the yardstick: the user-facing flows the target serves (request, tick-to-order, page load, frame, batch job), the metric per flow (p50, p99, p99.9 latency; throughput; wall time; frames dropped), the budget or SLO if one exists, and the realistic workload (production-shaped data, recorded traffic replay, the real input distribution). Take the target from `perf-review` when it supplies one.
2. Find or build the harness: an existing end-to-end benchmark, load test, or replay; otherwise the smallest harness that drives the real entry point with the real workload. Use open-loop constant-rate load scored against scheduled send time, HdrHistogram-style percentiles, and the error rate recorded alongside. Call the Skill tool with `perf-measurement` for the noise floor and environment rules.
3. Baseline on the base commit: steady state (long enough to pass warm-up and JIT), noise floor from an A/A run, resource totals (CPU seconds, peak RSS, allocations or GC time, bytes on the wire, statements issued). Run the Gregg checklist on the baseline itself before trusting it: why not double, was it tuned, did it break limits, did it error, does it reproduce, does it matter, did it even happen.
4. Run the same harness on the candidate, watching the system while it runs (active benchmarking) to confirm the limiter and that the workload actually executed.
5. Verdict per flow: improved beyond the noise floor, flat, or regressed. A regression on any yardstick blocks the ship until the offending commit is found (bisect the branch with the same harness) and dropped or reworked, whatever its microbenchmarks say. Report estimate, microbenchmark delta, and system delta side by side.

Done when every flow in step 1 has a baseline, a candidate number, and a verdict, or the report says which flow could not be driven and why.

## Checklist

- **Code growth**: inlining, unrolling, specialization or monomorphization that speeds one function and raises instruction-cache and TLB misses elsewhere. Check: binary or function size delta; whole-process cycles, not the one function.
- **Cache pollution**: a precomputed table, a cache, or a larger buffer that speeds its owner and evicts hotter data. Check: system cache-miss rate and RSS before and after.
- **Faster producer, slower system**: a sped-up stage fills a queue, a lock, or a consumer downstream faster than it drains (Little's law), so end-to-end latency rises or memory grows. Check: queue depths, lock wait time, p99 under constant-rate load.
- **Throughput bought with latency**: batching, coalescing or debouncing that raises items per second but adds wait to the common case. Check: p50 and p99 both, against the budget for that flow.
- **Memory for time**: caching or preallocation that cuts CPU but raises RSS, GC pause time, or page faults. Check: peak RSS, GC pause histogram, major faults.
- **Parallelism that contends**: new threads or tasks that win alone and lose beside the real co-tenant workload, or starve it. Check: run with the real neighbours present; CPU steal and run-queue length.
- **Generator lying**: a closed-loop load tool, a warm cache the user never has, a workload smaller than production, error responses counted as fast successes. Check: open-loop rate, cold and warm runs, error rate on the same line as latency.
- **Behaviour drift**: a changed default (window, preset, sampling) that makes the metric move for a reason the user will notice. Check: output equivalence on the workload, listed as a product decision in the report.

A microbenchmark says a function got faster; only this measurement says the program did, and when the two disagree the program wins.
