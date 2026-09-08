---
name: implement-with-subagent
description: Delegate an approved implementation plan to a bounded worker using the running harness's subagent reference, then verify and integrate the result. Use when asked to implement with subagents or hand off a substantial settled plan. For existing changes that only need commits, use commit-with-subagent.
---

# Implement with Subagent

Use `/subagent-routing` first. Follow its running-harness reference and common
assignment/result contract; this skill supplies the implementation workflow.

## Establish the plan and destination

Use the plan/spec explicitly associated with the user's request, or synthesize
the approved decisions from this conversation. Resolve only missing decisions
that materially affect the result. Define scope, excluded files, acceptance
criteria, validation, and whether delivery is a reviewed patch, local integration,
or a draft PR. Delegating implementation does not authorize merging a PR.

Record the exact target repository, starting commit, branch, and dirty paths.
For broad changes or concurrent harness writers, prepare an isolated worktree
at that commit. A new worktree excludes uncommitted changes: if the plan depends
on them, deliberately transfer only the approved inputs and verify the copied
state, or arrange exclusive in-place ownership. Preserve the original checkout.

## Delegate the build

Select the implementation role from the harness reference. Give the worker the
approved plan and exclusive file ownership. Use one integrated writer unless
independent phases have disjoint ownership. Keep useful, non-conflicting root work
moving while it runs; honor sequential dependencies before starting another phase.

Require the smallest change that satisfies the plan, surrounding style, and
targeted behavioral checks. Assign validation explicitly: the worker runs checks
that catch its regressions; the root owns any expensive/shared gates. Duration
alone is not a reason to substitute compilation for required behavioral evidence.
Changed test expectations must follow the requirement, not merely make tests pass.

The worker reports missing design decisions and persistent failures with a durable
partial result. Preserve its worktree/patch until the root has inspected it. If
the runtime tears down worktrees, require recoverable commits or an exported patch
before return. Checkpoint commits are local recovery artifacts, not publication.

## Verify and integrate

Read the result and compare the returned artifact against the recorded starting
commit. Inspect scope, behavior, changed expectations, and check evidence. Obtain
independent review where the common contract requires it; send concrete findings
back to the owning worker. Never label omitted or failed required gates green.

Integrate only into the authorized destination after checking its HEAD and dirty
state again. Inspect and validate the final combined snapshot; re-run checks when
integration or other changes invalidate earlier evidence. Preserve unrelated work.
For requested commits/publication, use `/commit-with-subagent` after verification.
Return changed files, validation, remaining risks, and the patch/worktree/commit or
draft PR location. Stop at the user's delivery target.
