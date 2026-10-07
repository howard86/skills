---
name: perf-concurrency
description: "Cut synchronization and scheduling costs on a hot path: lock amortization, short critical sections, no I/O under a mutex, sharding, false sharing, async runtime overhead, channel buffering, and work deferred off the latency-critical path. Use when the target has locks, atomics, channels, thread pools, or an async runtime, or when the user mentions contention, tail latency, or jitter."
---

# Perf Concurrency

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Lock per item**: acquiring a mutex once per element inside a loop. Fix: acquire once for the batch (one acquisition freed a whole tree in the source's example).
- **Long critical section**: allocation, formatting, logging, or a syscall while holding a lock. Fix: compute the decision under the lock, do the work outside it with the data copied out.
- **I/O under a mutex**: an RPC, file, or database call inside a critical section. Fix: move it out of the lock and hand the result back in.
- **Contended single structure**: one lock or one atomic counter every thread hits. Fix: shard when there is no cross-shard invariant (16-way sharding doubled throughput in the source); use different hash bits for the shard choice than the shard's own table uses.
- **False sharing**: hot fields mutated by different threads sitting in one cache line. Fix: pad or align the fields to the cache line; separate hot read-only from hot mutable fields.
- **Handoff for tiny work**: dispatching small items to a thread pool or spawning a task per item; one isolate or thread per invocation. Fix: process below a size threshold inline (the source used 16 KB); reuse one worker.
- **Async runtime overhead**: re-registering waiters every tick, boxing futures through dynamic-dispatch traits on the hot path, an unbuffered channel between a producer and consumer that run at different rates. Fix: keep the waiter registered, use static dispatch for the hot trait, buffer the channel to decouple timing.
- **Work on the critical path that could follow it**: logging, metrics, persistence, or notification done before the response or order is sent. Fix: send first, then record; deferring telemetry until after the order left was the largest single win in one run (22.7 to 2.6 microseconds per event).

Lock contention lowers apparent CPU usage, so a quiet profile can hide it; measure wall time and queueing, not CPU alone, and treat every concurrency change as needing an independent review.
