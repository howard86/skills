---
name: babysit-pr
description: Babysit an open PR's CI, review threads, and mergeability until it is merge-ready, merged, closed, or needs the user. Use for "babysit this PR", "watch CI", "keep an eye on the checks", "resume the babysit run", or a fan-out like "babysit #1133-#1147 with subagents".
---

# Babysit a PR

Input is a PR URL or number. Stay with the PR until it is genuinely clean: one status pass proves nothing while checks are still running or threads are still open.

Keep the PR URL, the head SHA, and any diagnosis keyed to that SHA in your own task or handoff state. Nothing in this loop keeps state between runs, so on resume that record is the only memory: reuse it, and re-diagnose a failure only when the SHA moved or new evidence arrived.

If the branch is behind its base or conflicting (confirmed against the compare API, since the `mergeable` flag lags), or the user asked for a rebase, call the Skill tool with `rebase-pr` first and start the loop on the head it pushes.

## The loop

1. **Status.** `gh pr view <ref> --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup,url`. `MERGED` or `CLOSED` ends the loop: report it.
2. **Wait out pending checks** before judging anything. Wait on the *run*, not each check: start the bundled waiter with `run_in_background` and wait for its completion notification, so a full CI cycle costs one notification rather than one per check:
   ```bash
   EXPECT_SHA=<headRefOid> ${CLAUDE_SKILL_DIR}/scripts/wait-for-checks.sh <ref>
   ```
   Branch on its **exit code**, not on re-reading status: `0` terminal and clean, `1` terminal with failures (named on stdout), `2` timed out still pending, `3` the head moved so a new push superseded this run (re-arm on the new SHA), `4` no checks ever registered (read the workflow's path filters). It refuses to call an empty check set "green", which is what a status pass straight after a force-push otherwise reports. Its header block documents the timing knobs.
3. **Unresolved review threads.** The REST/`--json` view doesn't expose them, so use GraphQL, paginating while `hasNextPage` (pass the previous `endCursor` as `-f cursor=…`):

   <!-- mod:skip id=threads -->
   ```bash
   repo_json=$(gh repo view --json owner,name)
   owner=$(jq -r '.owner.login // .owner.name' <<<"$repo_json"); repo=$(jq -r '.name' <<<"$repo_json")
   gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id,isResolved,isOutdated,path,line,comments(last:1){nodes{author{login},body,createdAt,url}}}}}}}' \
     -f owner="$owner" -f repo="$repo" -F number=<number> \
     | jq -r '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)
              | [.id,.path,(.line//""),(.isOutdated|tostring),(.comments.nodes[-1].author.login//""),(.comments.nodes[-1].body|gsub("\n";" ")|.[0:240])] | @tsv'
   ```
   <!-- /mod:skip -->

4. **Fix what's real.** Bot summaries are useful but not authoritative: verify each finding (and each failing check) against the code at the current head, since a thread may be outdated or already addressed. Commit focused fixes, run the repo's gates, push, and go back to 1 on the new head.
5. **Resolve a thread only after verifying its fix landed.** Where a generated artifact ships, check that source and artifact agree first:

   <!-- mod:skip id=resolve -->
   ```bash
   gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id,isResolved}}}' -f threadId=<thread-id>
   ```
   <!-- /mod:skip -->

6. **Merge-ready** when all four hold: checks passing or intentionally skipped, review decision acceptable, no actionable comments, no unresolved threads. Do one fresh sweep of status, threads, comments, and local `git status` first, then report the evidence: head SHA, check names and results, unresolved thread count, gates run, and any dirty files left untouched. Merge only when the user asked for it; otherwise merge-ready is the verdict and the watch continues until the PR is merged, closed, or needs the user.

**Known-red checks.** Before flagging a failing check, look in memory and project notes for checks documented as non-actionable (e.g. hft-market-server's Security Audit). State once that it's a known red and move on; it stays out of every later cycle's diagnosis.

## Fanning out across several PRs

Give each agent the loop up to merge-ready and keep merge authority in the top-level session: `gh pr merge` trips the permission classifier inside a subagent. Each agent hands back the PR number, the head SHA it verified, and the checks that passed; the top level merges on that evidence without re-running the sweep.

Merging moves the base, so merge one PR at a time and have each downstream PR rebased (via `rebase-pr`) onto the base as it stands before its own merge.
