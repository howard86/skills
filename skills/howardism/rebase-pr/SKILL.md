---
name: rebase-pr
description: Bring a PR branch current by rebasing it onto its remote base, resolving the conflicts, and force-pushing under an explicit lease. Use for "rebase this PR", "rescue this stale PR", "this PR conflicts with main", "update the branch", a stack of dependent PRs, or a fan-out like "rebase #1133-#1147 with subagents".
---

# Rebase a PR

Input is a PR URL or number. The job ends at a verified force-push; watching CI and reviews afterwards belongs to `babysit-pr`.

## 1. Read the PR and decide whether it needs a rebase

A "Precomputed rebase state" block injected at load is measured against the current checkout, not the PR branch: when the session sits on the base branch it reports "0 behind" and a clean merge-tree for a PR that conflicts (#1460). Trust only the compare API below.

```bash
gh pr view <ref> --json number,url,headRefName,headRefOid,baseRefName,isCrossRepository,maintainerCanModify,mergeable
```

Record `headRefOid` now as the **lease**: the remote head you are about to rewrite. It survives into step 5.

`mergeable: CONFLICTING` lags the real tree and goes stale. Confirm with the compare API before believing it:

```bash
gh api repos/{owner}/{repo}/compare/<base>...<headRefOid> --jq '{ahead_by,behind_by}'
```

`behind_by: 0` means the branch is already current and the flag is stale; there is nothing to rebase, so stop and say so. A cross-repo PR with `maintainerCanModify: false` can't take your push: stop and report before doing the work.

## 2. Check out and fetch

1. `gh pr checkout <ref>`, in a fresh worktree when the current tree is dirty or another branch is in use. For a fork PR this also wires the fork's remote as the push target.
2. Fetch the base from the remote that points at the **base** repository (`git remote -v`: `origin` in a plain clone, often `upstream` in a fork clone): `git fetch <base-remote> <base>`.
3. Confirm the local branch sits on the lease: `git rev-parse HEAD` equals the recorded `headRefOid`. A mismatch means someone pushed since step 1: re-read the PR and restart.

## 3. Rebase and resolve

```bash
git -c rerere.enabled=true rebase <base-remote>/<base>
```

`rerere` replays a resolution you already made when the same hunk conflicts again, which is what a repeatedly rescued PR hits.

On each stop, call the Skill tool with `resolving-merge-conflicts` and work the hunks, then `git rebase --continue` until the rebase completes. Preserve the PR's intent. One override of that skill: when a hunk is a **semantic collision** (both sides changed the same behaviour, so any pick invents a result), leave the rebase paused and report the hunk, both sides' commits, and the choice the user has to make.

Merge commits inside the PR branch are dropped by a plain rebase; the branch comes out linear, which is the intent.

## 4. Verify before pushing

Record `git rev-parse HEAD` as the **verified SHA** first; every check below vouches for that commit, and step 5 pushes it.

1. **Patches survived.** Compare the old commits with the rebased ones:
   ```bash
   git range-diff "$(git merge-base <lease> <base-remote>/<base>)..<lease>" <base-remote>/<base>..HEAD
   ```
   Every PR commit must map to a rebased one. A commit that vanished, or changed beyond its conflict hunks, is a bad resolution.
2. **Gates green.** Run the repo's own checks (typecheck, tests, lint) on the rebased tree. A clean textual rebase still breaks builds when the base renamed something the PR uses.
3. **Diff not empty.** If `git diff <base-remote>/<base>...HEAD` is empty, the base already contains the work: push nothing, report the evidence, and ask before closing the PR (closing is an external mutation that needs explicit approval).

## 5. Push under the lease

```bash
git push --force-with-lease=<headRefName>:<lease> <head-remote> <verified-sha>:<headRefName>
```

Push the verified SHA from step 4, never `HEAD`: a reused worktree can be rewritten by another session while the gates run (seen on #1458, where a concurrent rebase reset the branch to a different PR's commits mid-test). Check `git rev-parse HEAD` still equals it; a mismatch means stop, report, and leave that worktree alone.

Pin the lease to the recorded SHA. A bare `--force-with-lease` compares against the remote-tracking ref, which any later fetch (yours or an editor's background fetch) silently advances, so it can overwrite a push you never saw. A rejected push means the remote moved: fetch, inspect the new commits, and restart from step 1.

Report the old and new head SHAs, the commits range-diff matched, and the gates run. If the rebase touched only files the repo's CI path filters ignore, say so: no fresh CI cycle will start.

To watch CI and reviews on the new head, call the Skill tool with `babysit-pr`, handing it the PR URL and new head SHA.

## Stacks

A **stack** is PRs each based on the one below rather than on the trunk. Map the chain first with `gh pr view <ref> --json baseRefName,headRefName` on each PR. Rebase and push **bottom-up**: the lowest onto the trunk, then each PR above onto its parent's new head (`git rebase --onto <parent-new-head> <parent-lease> <branch>`, so only the PR's own commits move). Top-down leaves every PR above pointing at commits that no longer exist. Budget one CI cycle per PR.

## Fanning out across several PRs

One worktree per PR, one agent per PR, each running this skill to the push. Independent PRs rebase in parallel. Once any of them merges the base moves, so a PR rebased before that merge rebases again against the base as it stands.

A PR rebased three or more times is a smell: suggest merging or splitting it rather than a fourth rescue.
