---
name: perf-api
description: "Performance-aware interface shape: bulk operations over per-item calls, view parameters over copies, thread-compatible defaults, per-call setup hoisted out. Use when designing or reviewing an API, client, or library boundary that a hot path will cross."
---

# Perf API

## Process

1. Establish the hot path, or take the target as given by `perf-review`.
2. Sweep the checklist below over every function in the target.
3. Cost each finding against the dominant cost of the path stated in the brief (database round trip, network hop, LLM call, frame budget): call the Skill tool with `perf-measurement`.
4. Report: file:line | hint | change | estimate | confidence.

Done when every checklist item has been swept across every function in the target.

## Checklist

- **Chatty boundary**: a caller loops making one call per item (RPC, syscall, DB query, lock, FFI, any N+1). Fix: provide and use a bulk operation; amortize the crossing.
- **Copying signature**: the API takes or returns owned copies of data the caller already holds. Fix: accept views; return references or iterators where lifetime allows; offer a move-in path.
- **Hidden per-call setup**: every call re-does session, handle, regex, or config setup. Fix: hoist into an object constructed once (client, prepared statement, compiled pattern) and reused.
- **Synchronization by default**: internal locking every caller pays whether or not they share the object. Fix: default to thread-compatible (caller synchronizes); the one caller that shares adds the lock.
- **Forced materialization**: the API returns a complete collection when callers consume incrementally. Fix: expose a streaming/iterator form.
- **Callee recomputes what the caller already has**: a routine that allocates its own scratch buffer or re-derives a value (size, hash, parsed form) its caller holds. Fix: accept a caller-owned buffer or the precomputed value as a parameter.

Library code can't see its callers' hot paths, so its per-call costs multiply invisibly: apply this checklist to library boundaries even without a profile.
