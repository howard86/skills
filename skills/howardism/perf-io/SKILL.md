---
name: perf-io
description: "Cut data-path costs across the database, network, and serialization boundary: query shape and indexes, payload size, round-trip batching and coalescing, parse avoidance, cache keys and invalidation, reconnect and polling cadence. Use when a hot path crosses a database, an RPC or WebSocket, a message queue, or a serializer, or when a profile shows time waiting on I/O."
---

# Perf IO

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Query shape**: a query whose plan scans or sorts more rows than it returns (DISTINCT ON over a large set, ORDER BY without a matching index, an OFFSET that walks the table). Fix: rewrite to LATERAL or keyset form, add the covering index, confirm with EXPLAIN (ANALYZE, BUFFERS). One recorded rewrite went from 230 to 402 ms down to 0.2 ms.
- **Per-row statements**: a loop issuing one INSERT, UPDATE, or SELECT per element (N+1 at the storage layer). Fix: one statement over an array (unnest, IN, bulk upsert) or one join; 10,104 statements became 104 in one run.
- **Over-fetching columns and rows**: selecting raw JSON or blob columns the caller never reads, or returning the full history when the client shows a page. Fix: project only consumed columns, bound the window, paginate server-side; 29.5 MB became 508 KB.
- **Payload shape on the wire**: a list endpoint or WebSocket snapshot carrying nested objects, duplicate keys, or unbounded arrays. Fix: flatten, cap, delta-encode or bound the snapshot; keep a long-lived payload in its serialized form rather than re-encoding per subscriber.
- **Parse before necessity**: fully deserializing every message when a header field or a fingerprint decides whether it is needed (replicated feeds were about 80 percent duplicates). Fix: check the cheap field first, dedupe before parse, parse only the fields the consumer reads.
- **Round trips not coalesced**: several sequential requests from one caller (page waterfalls, per-frame writes, one WebSocket per browser tab). Fix: batch, pipeline, share one connection, write per frame batch; 200 statements per tick became 10, 38 sockets became 1.
- **Cache that cannot hit**: a key built from the current time, a fresh object identity, or an unstable query-key array; a cache with no invalidation rule. Fix: key on the inputs that determine the value, state the invalidation rule and expected hit rate; a cache keyed on the current time had a 0 percent hit rate.
- **Reconnect and poll cadence**: retry without backoff or jitter, polling faster than the data changes, catch-up running before the live stream is attached. Fix: exponential backoff with a cap, poll at the data's cadence, attach live then catch up; one storm went from 43 to 6 connects per minute.

These costs hide behind client libraries and ORMs, so they rarely show in a CPU profile; count statements, bytes, and round trips per unit of work instead.
