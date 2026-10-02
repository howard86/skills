# delegation-plan eval

Measures what a root session does right after loading `implement-with-subagent` on an approved plan: how many implementers it launches together, on which model, with what ownership, and whether it withholds commits for a separate committer.

Each case replays a real session from `~/.claude/projects` up to the prompt that triggered the skill ("implement all", "apply all"). It forks the session headless with `claude -p` in a throwaway clone at that moment's commit and sends the same prompt again with today's skills. `hooks/record-agent.ts` records and denies every spawn, so no worker runs. `hooks/guard.ts` denies writes outside the clone and anything that publishes. The grader scores the recorded spawns against each plan's labelled work packages.

## Run

```sh
bun evals/delegation-plan/run-eval.ts --flow .claude/hillclimb/delegation-plan --variant baseline \
  --model claude-opus-5-5 --reps 2 --concurrency 5 --timeout-s 1800
EVAL_ONLY=7b365773,f9386bf8 bun evals/delegation-plan/run-eval.ts ...   # a subset
bun test evals/delegation-plan                                           # grader checks, no model calls
```

The runner refuses to start until a person reviews the harness and passes `--approve-harness`. That records a sha over the runner, `cases.json` and both hooks, so any edit to them needs a fresh approval. Each case is capped at `EVAL_MAX_USD` (default 8) through `--max-budget-usd`.

Build the report with the claude-api skill's `build-report-lite.mjs` (or `build-report.mjs`) on the flow directory.

## Cases

`cases.json` holds session ids, the trigger record's uuid, the repo and commit, and the labels. It never holds plan or prompt text: the runner reads those from the transcript at run time, so the private repos the plans quote stay out of this public repo. Results and traces land under `.claude/`, which git ignores.

Labels came from Sonnet readers of each transcript, reviewed by hand:

- `packages`: plan items grouped so that no two packages share a file.
- `start`: packages with no unmet dependency. These should launch in one turn.
- `opus_ok`: startable packages holding a design decision the plan leaves open.
- `shape`: `parallel` (start of 2 or more), `chain` (several packages that must run in order) or `single`. The chain and single cases are the negatives: over-splitting fails there.
- `weak`: the plan is partly outside the replayed transcript.

`commit` prefers the base commit seen in the transcript (`commit_source: label`). `git rev-list --before` on the session's branch picked the wrong commit for 12 of 31 cases, because those branches were rebased after the session.

## Metrics

| id | passes when |
|---|---|
| `split_ok` (headline) | implementers launched together equal `start` exactly |
| `tier_ok` | Opus implementers are at most `opus_ok`, or every implementer uses the model the user named |
| `coverage` | continuous: min(launched, start) / start |
| `solo_ok` | the root edits no project file itself |
| `commit_withheld` | every implementer brief forbids committing (empty with no implementers) |
| `disjoint_ok` | implementers get distinct workspaces or non-overlapping owned paths (empty below two) |

A spawn's role (implementer, reviewer, committer, other) comes from its description's leading verb, then from its brief. A spawn with no `model` runs on the root's model.

## Harness gotchas

- A trigger that opened its session has nothing to resume, so the case starts a fresh session instead of `--resume`.
- `-p` under `auto` permission mode denied ordinary skill reads, so the replay runs under `bypassPermissions`. The guard and the sandbox are the safety layers.
- The sandbox blocked writes outside the clone and temp dirs, but its network allowlist merges with the user's own settings and let `api.github.com` through. The guard refuses `gh` and `git push` itself.
- A guard that inferred writes from Bash command text denied reads (`git branch --show-current`, `2>/dev/null`) and steered roots off their real path. Bash writes are left to the sandbox.
- `-p` exits when the turn ends, so the guard refuses background Bash and Monitor. Otherwise a root that waits on a background build ends the run before it delegates.
- The replayed prefix and the fork are deleted after each case, so they never enter the transcript corpus that chat-history and retro scan.
