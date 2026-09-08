# Common subagent contract

## Delegate when it earns its cost

Use the fewest workers needed for independent bounded work, noisy exploration,
or independent review. Keep small sequential changes with the root when a handoff
adds more work than it removes. A user explicitly requesting delegation supplies
that workflow preference; explain a runtime blocker rather than silently claiming
root work was delegated. Further delegation requires root authorization and
runtime support.

## Assignment

Every brief contains:

```text
Role and mode: harness, requested model/effort, read-only or write-enabled
Objective: one outcome and why the root needs it
Context: relevant plan/spec, files, symbols, errors, and starting commit
Ownership: absolute repo/worktree, permitted files or hunks, index owner
Constraints: compatibility, excluded work, publication authority
Deliverable: patch, decision, commits, or evidence
Validation: required commands and who runs each
Stop: completion criteria, blockers to report, no further delegation unless authorized
```

Pass the actual task context, not a pointer to an unrelated recent plan. Use the
runtime's supported context mechanism; include critical scope and constraints even
when history is inherited. Independent reviewers receive the requirements and
artifacts, without being coached toward the author's conclusion.

## Ownership and evidence

Parallelize independent reads first; integrate through one writer where practical.
Test runs that modify snapshots, generated files, fixtures, or databases count as
writes. Use exclusive paths or separate worktrees for writers. A reviewer reports
findings without editing the implementation it reviews.

The root waits for every result needed by the next decision, verifies consequential
claims against source and observed output, resolves disagreements with evidence,
and inspects the final diff. Security, concurrency, database, infrastructure,
authentication, authorization, payment, and trading changes receive independent
review unless trivial. Select an arbiter from the running harness reference when
judgment remains necessary.

## Required result

```text
STATUS: done | partial | blocked
SUMMARY: outcome or conclusion
EVIDENCE: files, symbols, commands, decisive output, sources
CHANGES: files and why, or none; branch/commit/worktree when applicable
VALIDATION: checks actually run and results; omissions and reasons
RISKS AND UNKNOWNS: unresolved issues, requested vs confirmed runtime settings
RECOMMENDED NEXT ACTION: smallest useful next step
```

Completion requires the requested behavior, appropriate observed checks, final
diff inspection, and preservation of unrelated work. A started command is not a
passing check. A durable partial patch is not a completed implementation. When
blocked, return the exact error, attempts, recoverable artifacts, and what would
unblock the task. On pause/stop, safely stop owned workers, retain a compact
checkpoint, and launch no replacement round until resumed.
