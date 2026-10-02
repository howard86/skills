---
name: implement-with-subagent
description: Split an approved implementation plan into packages with disjoint files, delegate one bounded worker per package in parallel using the running harness's subagent reference, then verify and integrate the result. Use when asked to implement with subagents or hand off a substantial settled plan. For existing changes that only need commits, use commit-with-subagent.
---

# Implement with Subagent

Call the Skill tool with `subagent-routing` first. Follow its running-harness
reference and common assignment/result contract; this skill supplies the
implementation workflow.

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

## Split the plan into packages

A **package** is a set of plan items whose files no other package touches. Items
that share a file (a lockfile, a generated artifact, a shared module) form one
package. Order packages by dependency: a package that builds on another's code, or
a phase the plan places after another, waits for it.

Every package with no unmet dependency launches in the same turn, one worker each,
in its own worktree or with an exclusive path list. The rest launch as their
dependencies are verified. One worker for the whole plan is the right shape only
when the plan is one package; several packages handed to one worker run serially
and lose the parallelism the split exists for.

The root's own work is integration: worktrees, briefs, open decisions, review and
verification. Package implementation belongs to the workers, including after a
worker fails, when the fix goes back to a worker with the concrete finding.

## Choose each worker's model

Route each package's brief separately: a bundled brief takes the tier of its
hardest item and truncates. Implementers start on the harness reference's
implementer tier. A package moves up a tier when its brief leaves a design decision
open that the root cannot settle first, or when a worker on the lower tier failed
on substance; record which. Risk raises the reviewer's tier, not the implementer's
(common contract). Fix rounds from concrete review findings start on the
implementer tier. A model the user named overrides all of this.

## Brief each worker

Give each worker the approved plan items for its package, its exclusive file
ownership, and the packages running beside it. Keep useful, non-conflicting root
work moving while workers run.

Require the smallest change that satisfies the plan, surrounding style, and
targeted behavioral checks. Assign validation explicitly: the worker runs checks
that catch its regressions; the root owns any expensive/shared gates. Duration
alone is not a reason to substitute compilation for required behavioral evidence.
Changed test expectations must follow the requirement, not merely make tests pass.

Workers leave their changes uncommitted: commit grouping and messages belong to
`commit-with-subagent` after the root has verified the combined result. When the
runtime tears down worktrees, the worker exports a patch or makes one checkpoint
commit marked as such, a local recovery artifact the committer regroups.

The worker reports missing design decisions and persistent failures with a durable
partial result. Preserve its worktree/patch until the root has inspected it.

## Authorized bridge route

When `subagent-routing` selects an authorized Agent Bridge route, retain the
immutable assignment and returned task id with the plan. Record every attempt's
effective target, model, effort, outcome, changed paths, validation, and
reconciliation status. Treat `AgentUsage` as usage provenance, not a completion
signal: missing capacity or consumption remains unknown. A bridge worker's
permission does not authorize the root to publish its work. One integrator still
reviews and accepts the result, then follows separate user authorization for any
commit, push, or pull request.

## Verify and integrate

Read the result and compare the returned artifact against the recorded starting
commit. Inspect scope, behavior, changed expectations, and check evidence. Obtain
independent review where the common contract requires it; send concrete findings
back to the owning package's worker. Never label omitted or failed required gates green.

Integrate only into the authorized destination after checking its HEAD and dirty
state again. Inspect and validate the final combined snapshot; re-run checks when
integration or other changes invalidate earlier evidence. Preserve unrelated work.
For requested commits/publication, call the Skill tool with `commit-with-subagent`
after verification.
Return changed files, validation, remaining risks, and the patch/worktree/commit or
draft PR location. Stop at the user's delivery target.
