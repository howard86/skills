---
name: commit-with-subagent
description: Delegate atomic commits for approved existing changes, verify the resulting commits, and push or open a draft PR only when requested. Use for commit hygiene or delegated commit/PR delivery after implementation is complete.
---

# Commit with Subagent

Call the Skill tool with `subagent-routing` first. Follow its running-harness
reference and common assignment/result contract. Select an implementation-capable worker for commit
boundary judgment; a scout is suitable only for already-settled mechanical groups.

## Scope the handoff

Inspect the exact repo, branch/HEAD, staged and unstaged diff, untracked paths,
recent commit style, and merge/rebase state. Record approved files/hunks and
pre-existing staged changes separately. Preserve everything outside that scope.
A clean tree means no new commits; if the user requested publication of existing
commits, continue to the publication checks instead of treating it as a no-op.

Record delivery as commit-only, push, or draft PR from the request and existing
authorization. Being on a feature branch does not authorize a push. Verify the
intended remote and base branch from remote metadata/configuration; do not guess
between main/master or publish from detached HEAD. If publication needs a feature
branch, use the repo's branch convention rather than publishing the default branch.

A worker completed through Agent Bridge has execution authority only. Its task
record, attempts, or permission posture do not add commit or publication
authority. The named integrator still verifies the patch and follows the delivery
authority in this skill.

The committer works where the approved uncommitted changes exist. Give it exclusive
ownership of that worktree's index and files for the handoff; the root and other
writers wait or work elsewhere. If exclusivity cannot be established, prepare
commit groups read-only and leave mutation pending. A separate worktree needs an
explicit, verified transfer of approved inputs before it can commit them.

## Create local commits

Give a self-contained brief with the starting state, exact scope, proposed groups
if already known, validation evidence, and commit-only authority for this phase.
The worker reads the live diff, groups changes by concern, and stages only approved
paths or selected hunks. Separate concerns within one file at hunk granularity.
Preserve unrelated staged entries: a plain commit of the entire existing index is
not scope-safe. If selective staging cannot preserve them reliably, report the
blocker before changing the index.

Run hooks normally. Inspect HEAD/status after a hook failure instead of assuming
whether a commit happened. Restage only in-scope hook changes and rerun affected
checks. An out-of-scope hook rewrite is a blocker, not permission to absorb it or
discard another writer's work. No bypassed hooks, blanket staging, or automatic
reset/force-push recovery.

## Verify, then publish if requested

After the worker returns, the root inspects every new commit and the aggregate
diff against the recorded baseline. Verify atomic boundaries and messages,
accounting for every approved hunk, required checks, and preservation of unrelated
tracked, staged, and untracked work. A globally clean tree is not the success test.

Only after that review, perform the authorized push and/or create or update one
draft PR for the intended branch. Check for an existing PR first; verify remote,
base, head, and published commit. Use a cohesive problem/change/validation body,
not just a commit list; with `gh`, pass multiline text through `--body-file` and
create with `--draft`. Do not merge. If publication tooling or auth is unavailable,
report local commits as complete and publication as blocked, with the exact reason.

Return commit IDs, validation, PR URL when applicable, and remaining scoped or
unrelated work. Do not claim hosted CI passed without observing it at the published
commit, and do not start ongoing monitoring unless requested.
