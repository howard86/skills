---
name: rebase-babysit
description: Rebase a PR branch onto its base, resolve conflicts, force-push, then babysit its reviews, CI, and mergeability through merge or closure. Use for "rebase and babysit this PR", "rescue this PR", "update this stale PR and watch CI", "resume the rebase/babysit run", or a fan-out across many PRs like "rebase-babysit #1133-#1147 with subagents".
---

# Rebase and Babysit a PR

One composite: bring the PR current, surface merge-ready as a milestone, then keep watching until the PR is merged, closed, or needs user help. Input is a PR URL or number; resolve it with `gh pr view <ref> --json headRefName,baseRefName,url,headRefOid`.

Keep the concrete PR URL and head SHA in your own task/handoff state. On resume, reuse them, along with any diagnosis keyed to a SHA that hasn't moved, instead of starting discovery again — the watcher itself keeps nothing between runs, so this is the only thing that survives.

## 1. Rebase

1. Check out the PR branch (`gh pr checkout <ref>`) — in a worktree if the current tree is dirty.
2. `git fetch origin` and rebase onto the base branch (`git rebase origin/<base>`).
3. Conflicts → follow the `resolving-merge-conflicts` skill. Preserve the PR's intent; when a conflict looks like a semantic collision (both sides changed behavior), stop and report instead of guessing.
4. `git push --force-with-lease`.
5. Record the new head SHA after the push. The new SHA invalidates old SHA-specific CI diagnosis, but keep the PR URL and watcher state/review cursor.

`mergeable: CONFLICTING` from `gh pr view` lags the real tree and goes stale. Confirm it against the compare API before believing it — `gh api repos/{owner}/{repo}/compare/{base}...{head} --jq '{ahead_by,behind_by}'`. `behind_by: 0` means the branch is already current, the flag is stale, and the next push clears it; there is nothing to rebase.

If the rebase changed only files the repo's CI ignores, the push needs no fresh CI cycle — read the workflow's path filters before waiting on one.

## 2. Babysit

Stay with the PR until it is genuinely clean — one status pass proves nothing while checks are still running or threads are still open. Loop:

1. **Status.** `gh pr view <ref> --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup,url`.
2. **Wait out pending checks** before judging anything. Wait on the *run*, not each check — start the bundled waiter with `run_in_background` and wait for its completion notification, so a full CI cycle costs one notification rather than one per check:
   ```bash
   EXPECT_SHA=$(git rev-parse HEAD) ${CLAUDE_SKILL_DIR}/scripts/wait-for-checks.sh <ref>
   ```
   Branch on its **exit code**, not on re-reading status: `0` terminal and clean, `1` terminal with failures (named on stdout), `2` timed out still pending, `3` the head moved so a new push superseded this run — re-arm on the new SHA, `4` no checks ever registered (check the workflow's path filters). It refuses to call an empty check set "green", which is what a status pass straight after a force-push otherwise reports. Its header block documents the timing knobs; read them there.
3. **Unresolved review threads.** The REST/`--json` view doesn't expose them, so use GraphQL, paginating while `hasNextPage` (pass the previous `endCursor` as `-f cursor=…`):
   ```bash
   repo_json=$(gh repo view --json owner,name)
   owner=$(jq -r '.owner.login // .owner.name' <<<"$repo_json"); repo=$(jq -r '.name' <<<"$repo_json")
   gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id,isResolved,isOutdated,path,line,comments(last:1){nodes{author{login},body,createdAt,url}}}}}}}' \
     -f owner="$owner" -f repo="$repo" -F number=<number> \
     | jq -r '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)
              | [.id,.path,(.line//""),(.isOutdated|tostring),(.comments.nodes[-1].author.login//""),(.comments.nodes[-1].body|gsub("\n";" ")|.[0:240])] | @tsv'
   ```
4. **Fix what's real.** Bot summaries are useful but not authoritative — verify each finding against the code at the current head, since a thread may be outdated or already addressed. Commit focused fixes, run the repo's gates, push, and go back to 1.
5. **Resolve a thread only after verifying its fix landed** — where a generated artifact ships, check that source and artifact agree first:
   ```bash
   gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id,isResolved}}}' -f threadId=<thread-id>
   ```
6. **Stop** when all four hold: checks passing or intentionally skipped, review decision acceptable, no actionable comments, no unresolved threads. Do one fresh sweep of status, threads, comments, and local `git status` first, then report evidence — head SHA, check names and results, unresolved thread count, gates run, and any dirty files you left untouched.

Report CI-green, review-clean, mergeable as a milestone on the way. If you are resuming, don't re-diagnose failures on a SHA that hasn't moved without new evidence — that memory is yours to keep, and nothing in this loop carries state between runs.

Known-red checks: before flagging a failing check, check memory/project notes for checks documented as non-actionable (e.g. hft-market-server's Security Audit). State once that it's a known red and move on — do not re-diagnose it each cycle.

## Fanning out across several PRs

Give each agent the rebase-and-verify loop only, and keep merge authority in the top-level session: `gh pr merge` trips the permission classifier inside a subagent, so an agent that satisfies all four stop conditions reports merge-ready and stops there. Have it hand back the PR number, the head SHA it verified, and the checks that passed — the top level merges on that evidence rather than re-running the sweep for every PR.

Merging moves the base, so sequence the merges and let each downstream agent rebase onto the base as it stands.

A **stack** — each PR based on the one below it rather than on the trunk — rebases and force-pushes **bottom-up**: rebase the lowest onto the trunk and push, then rebase each PR above onto its parent's new head. Top-down leaves every PR above pointing at commits that no longer exist. Map the chain with `gh pr view <ref> --json baseRefName` on each PR before touching anything, and budget one CI cycle per PR.

## Notes

- Long-lived PRs that need repeated rescue (rebased 3+ times) are a smell — suggest merging or splitting rather than a fourth rebase.
- If the rebase empties the diff (base already contains the work), do not push an empty branch. Report the evidence and ask before closing the PR; closing is an external mutation that requires explicit approval.
