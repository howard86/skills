# Retro: 2026-08-30 to 2026-09-29, with a skill-usage focus

Scope: 30-day scan by `retro-scan.ts` (1,141 rows, 612 hand-typed after the noise filter; Jev
classified all 612 for $0.02), eight read-only verification workers (nudges 20, corrections 30,
keyword gaps 86, repeats 18), the rules-engine audit log, and a root check of where worker
transcripts land. Twenty-five of the thirty days overlap the 2026-09-24 retro, applied five days
ago, so most of what the scan surfaces is either already fixed or too recent to have been
exercised. Session ids are worker verdicts carried forward unless marked "root".

## Findings, ranked

### 1. The turn ends while a spawned worker is still running

The only genuine friction in 20 nudges. Session 03af859f twice: a 1h idle after the turn ended
with the bench-loop worker still running, then a turn that closed with "Next: the rebase"
instead of rebasing. Session 41bde636: "wait for luna", turn ended, the user came back 75
minutes later to a finished worker nobody had read. The 2026-09-24 retro found the same shape
(ace22bf3, a CI babysit agent left running). Four instances across two retros, all with a
delegated worker in flight; no API error, limit, or sleep before any of them. The
rules engine already sees `SubagentStart` and `SubagentStop` (it logs both) but keeps no
per-session count, and its two Stop rules gate on uncommitted work and concessions only.
Fix: track starts minus stops in session state and add a `stop-live-workers` Stop rule
that fires when the count is positive: wait for the result or state why the turn ends with
work in flight. Destination: rules engine (`engine.ts` plus one rule file).

### 2. The retro's skill table counts root loads only, so worker-side skills read as unused

`perf-algorithms`, `perf-api` and `perf-overhead` show 0 loads for the window while
`perf-review` was typed 11 times and briefs each angle worker to load its member skill.
Root check of 20d1a106 (2026-09-22): its four named angle workers each loaded their member
skill plus `perf-measurement`, but a named worker's transcript is its own session file
beside the parent, and `chatlog prompts` without `--include-agents` drops those rows, so the
table never sees them. The same blind spot hides `subagent-routing` and `commit-with-subagent`
loads inside implementer workers (ee81e6d0, 34d6430f). Fix: `retro-scan.ts` tallies skill
banners in agent sessions into a separate `worker` column, and the retro skill's step 1 says
the `loaded` column is root-only. Destination: this repo.

### 3. Two keyword patterns in the scan are miscalibrated against Jev and the verdicts

`implement-with-subagent`: regex 48 gaps, Jev 4. Every verified "applies" was an explicit
"with sub-agents" prompt (72b7340f, 78802025, c4047cb9, f1a6b919, e39c09a0); the bare
`implement` keyword flags each "implement all", which `workflow-apply` already owns.
`commit-with-subagent`: regex missed the three cleanest positives, all "create commits ..."
(c0b4d13e, 6133fa2b, dffce028), which Jev caught at 0.94 to 0.99. Fix: drop bare `implement`
from the first pattern and add `create commits` to the second. Destination: this repo,
`retro-scan.ts`.

### 4. Fixes shipped by the last two retros have had no trigger yet (baseline, no action)

- `babysit-skill` and `research-skill` (rules, 2026-09-24): zero firings. No prompt has opened
  with `babysit` or `research` since they landed (root: audit log and a 6-day prompt grep).
- `agent-status` and `disk-cleanup` (skills, 2026-09-23): zero loads. All 13 verified matching
  prompts date 2026-09-02 to 2026-09-14 (882b57b0, cd2243b5, e046062b, 2faaeeca, 41bde636,
  8afceaa5, 11d0bc7a, 7a41363c).
- `agent-docs-skill` (rule, 2026-09-24): fired once, 2026-09-29, in a worker writing a new
  SKILL.md by heredoc; that session then loaded `writing-for-agents` (root: 85540545). One
  for one.
- `commit-contract` (rule, 2026-09-23): `commit-with-subagent` loaded 12 times in the five
  days since the last retro against 7 in the 25 days before it (root: banner count).

### 5. Commit attribution: repeat of the 2026-09-24 finding 6, already decided

The two standing-rule-gap verdicts in 30 corrections are both 2da15f9e (2026-09-14, "remove
attribution", twice). The previous retro asked and the answer was trading-framework only, so
the project memory stands. Reported once here as the repeat it is; not re-asked.

### 6. `opencli-autofix` Step 6 still says to file an upstream issue

Memory `feedback_no_upstream_opencli_issues.md` says never to (356fe9b6, 2026-09-10). The skill
text disagrees with the memory. It is a third-party skill, so editing it does not stick; the
memory is the durable fix and it has held (no later occurrence). Recorded, no action.

## Applied 2026-09-29

Findings 1, 2 and 3 plus the `synced` audit exclusion were approved; 4, 5 and 6 need nothing.
Two Sonnet workers, one per repo, both in place and uncommitted.

| Where | Change |
|---|---|
| rules engine | `stop-live-workers.md` (new, code-backed Stop rule) and `engine.ts`: session state tracks `liveAgents` from `SubagentStart` to `SubagentStop`; a Stop with a live worker blocks once per session, guarded by `stop_hook_active`. Verified end to end with isolated state: block on live worker, no block after the worker stopped, no block on the retry, no block a second time. `selfcheck.ts` passes. All 400 recorded `subagent-start` rows carry an agent id, so native workers are always tracked; a worker whose stop never fires (killed, crashed) leaves a stale id and can earn one spurious block, and Agent Bridge workers are invisible to it. |
| this repo | `retro-scan.ts`: a second `chatlog prompts --include-agents` run supplies the agent rows (chatlog marks none, so the multiset difference is the signal); they feed only a new `worker` column. Same 8-day window against the old script: every section byte-identical except the table (four perf rows appear: perf-memory 5, perf-algorithms 4, perf-api 4, perf-overhead 4; perf-measurement worker 17) and the gap section moved by the pattern change (implement-with-subagent 8/16 to 3/3, commit-with-subagent 14/26 to 15/28). Scan time 1s to 3.4s. |
| this repo | `retro-scan.ts` patterns: bare `implement` dropped, `create commits` added; self-check covers both. |
| this repo | `CLAUDE.md` audit loop now walks `~/.claude/skills` too and skips `synced`; `retro/SKILL.md` names the three columns; changeset `retro-scan-worker-loads.md`. |

Left alone on purpose: `retro-scan.ts` has three em-dashes in output strings (lines 320, 347, 467) that predate this change; the repo rule covers prose and comments and the worker did not touch adjacent code. `selfcheck.ts` in the rules engine has no Stop-after-SubagentStart case because its corpus is command-only; the manual run above is the only coverage.

### Caveat follow-ups, applied 2026-09-29

All six proposals from the caveat review were approved and landed, two Sonnet workers again, uncommitted.

| Where | Change |
|---|---|
| rules engine | Kill removes the id: `PreToolUse` on `TaskStop` (`task_id`, deprecated `shell_id`; confirmed against the live schema) and on the bridge `StopAgent` (handle or alias). `SessionEnd` already unlinks the state file, so nothing was added there. |
| rules engine | Age in the reason: `liveSince` per id; the block lists `id (Nm)` or `XhYm`. |
| rules engine | Agent Bridge: a background bridge `Agent` launch is tracked as `bridge:<handle>` with its `name` alias; removed by `StopAgent`, an `AgentOutput` or `ListAgent` response with a terminal status (`completed`, `failed`, `killed`). Foreground launches are never tracked. Matching runs on the stringified `tool_response`, tolerant of escaped quotes. |
| rules engine | `selfcheck.ts`: ten `live-workers` cases (native block, stop, `stop_hook_active`, once-only, TaskStop, bridge block, StopAgent by alias, ListAgent terminal, foreground untracked, AgentOutput terminal). One type error the worker left (`string \| undefined` from `matchAll`) fixed at root; `tsc --noEmit -p .` is clean. |
| this repo | `chatlog prompts --include-agents` prints agent rows with a fourth header token, `agent` (`formatPromptRow`, pure, self-checked). `retro-scan.ts` reads the token, spawns chatlog once, and drops `agentRowsOf`; `--prompts <file>` now yields worker counts when the dump was taken with `--include-agents --width 0`. Same 8-day window: 0.88s to 0.52s, output identical apart from the intended cells. |
| this repo | Worker rows feed `projects`, `first`, `last` (perf rows 0 to 4 projects). |
| this repo | Three em-dash output strings rewritten; `CLAUDE.md` rule now names string literals that print prose; `chat-history/SKILL.md` documents the `agent` token; changeset extended. |

The rule fired on this very session while the second worker was running, naming the live agent id, and let the turn end once it was stated that a native Agent re-wakes the session. Still open by design: a bridge worker that finishes with no later poll stays listed until the once-per-session block; a saved dump taken without `--include-agents` reads `worker` as 0.

## Skill usage, what the window shows

- **The delegation trio is the workload.** `subagent-routing` 70 loads across 15 projects,
  `implement-with-subagent` 23, `commit-with-subagent` 19; the renamed predecessors show 9 and
  2 loads, all before the 2026-09-08 rename, and none since.
- **User-typed skills**: `lint` 24 (a trading-framework command, not this repo), `perf-review`
  11, `research-cycle` 10, `retro` 8, `rebase-babysit` 7 typed plus 2 model loads. Vault
  commands (`ingest`, `compile`, `query`, `vault-retro`, `campaign`) show as typed-only because
  they are read with `cat` and leave no marker.
- **Never loaded at root this window** among promoted howardism skills: afk-issue-loop,
  bun-workspace-quality, codex-fewer-permission-prompts, codex-refine-harness, find-skills,
  migrate-to-shoehorn, refine-harness, refine-skill, refresh-harness-references,
  setup-pre-commit, git-guardrails-claude-code. Same list the 2026-09-09 retro's finding 1
  drew for the upstream `engineering/` set; nothing changed and nothing new to propose.
- **Mid-sentence `/x` mentions**: 15, all commands or vault skills read with `cat`, none a
  `skill-mention` miss. The rule has fired 9 times all-time.
- **`~/.claude/skills/synced`** is the one non-symlink entry the CLAUDE.md audit loop flags. It
  is a claude.ai sync bucket (`.bucket-<id>` marker, 2026-09-17), not a frozen skill copy. The
  audit command reports it every run; it can be excluded there.

## Recorded, no action

- **Repeats are the workflow.** All 18 clusters verified as distinct tasks or workflow closers
  ("apply all" 9, "create atomic commits and PR" 8, "commit" 4), except two 2× recurrences:
  the wiki import into howardism-monorepo (24880534 2026-08-27, 66ca6d15 2026-09-16) and the
  stale-worktree review (8afceaa5, 7a41363c; `disk-cleanup` now covers it). Twice does not
  earn a skill. The `ssh company-ng` rows are pasted terminal output from one bench session
  (e4fc4553), an automation echo.
- **Nudges**: 4 spend-limit resets, 4 machine sleeps, 1 ENOTFOUND, 9 not nudges (menu picks,
  handoff openers, a stray keystroke). The two genuine ones are finding 1.
- **Corrections**: 30 verified; 14 were regex false positives on "remove", "discard", "stop"
  or a first prompt after `/clear`; 8 covered by `fix-verify`, `git-add-all` (on 2026-09-14,
  after its 09-02 trigger, and deliberately off in linked worktrees) or memory; 6
  task-specific design steers. Jev caught 3 of 16 regex rows and missed the attribution one
  (0.08), so for corrections the regex list stays the fallback the skill says it is.
- **Jev calibration elsewhere**: nudges regex 19 / Jev 17 with 17 in common; perf gaps 7
  applies of 12 verified, Jev's 16 closer than the regex 58; agent-status 10 applies of 13,
  Jev caught 9. Jev is the better gap detector, the regex the better correction detector.
- **Long prompts** (10): pasted logs, bench output, one diagram style guide injected by the
  harness (a220a23f, a regex false positive on "agent"). No re-explained instruction set.

# Retro: 2026-08-25 to 2026-09-24

Scope: 30-day scan by `retro-scan.ts` (1,336 rows, 737 hand-typed after the noise filter),
five read-only verification workers (nudges 12, corrections 18, keyword gaps 47, repeats 20),
and the rules-engine audit log for rule firing dates. Every session id below is a worker
verdict carried forward; none was re-read at root.

## Findings, ranked

### 1. "babysit" typed without a slash never loads `rebase-babysit`

13 gap prompts against 13 hits. Five of six sampled sessions ran the skill's exact workflow by
hand: manual `gh pr` polling plus an armed watch loop (28c10bdc, 1df359a0, 66cf8bc9, 443017d9,
f131519d; d42488d3 was editing the skill itself). The `skill-mention` rule only fires on a
slash, and the skill description already lists these phrases, so the description is not the
lever. Fix: a `UserPromptSubmit` rule keyed on a leading `babysit` (unless the prompt starts
with `/`) that says to call the Skill tool with `rebase-babysit`. Destination: rules engine.

### 2. "research ..." typed 24 times, `research` skill loaded once

15 of 16 sampled sessions did what the skill specifies (primary sources via context7 or the
repo's own code, findings written to a Markdown file or artifact) inline at root instead of
through the skill's background worker (73c2a7cc, 8d194c25, 1095b6c1, f8aedba5, 9159f692,
1f9afdce). The skill dates from 2026-07-01, so every gap postdates it. Two readings: the skill
is wanted and needs a trigger, or inline research is the preferred behaviour and the skill's
description should say when it does not apply. Fix if the first: a `UserPromptSubmit` rule
keyed on a leading `research` naming the skill. Destination: rules engine.

### 3. SKILL.md and CLAUDE.md edited by hand without `writing-for-agents`

8 gaps; 6 of 7 sampled were genuine skill or instruction-file authoring done without loading
it: a CLAUDE.md section appended by heredoc (698b1953), a global CLAUDE.md rewrite (d55894c3),
direct edits to chat-history, retro and refine-skill SKILL.md (9103b0e6, 5d786485), a
frontmatter invocation diagnosis (0f859cd4). The skill loads 19 times model-side elsewhere,
so the miss is when the edit is incidental to a larger task. Fix: a `PreToolUse` rule on
Edit/Write/Bash whose target path matches `SKILL.md`, `CLAUDE.md` or `AGENTS.md`, `once:
session`, injecting "call the Skill tool with `writing-for-agents` before the next edit".
Per the 2026-09-09 experiment an inject lands after the matched call, so the first edit
escapes; a deny would cost a turn. Destination: rules engine.

### 4. `perf-evidence` fires ~30 times a month but names no skill

61 perf gaps; 5 of 7 sampled were hot-path, benchmark or memory-layout work matching
perf-algorithms, perf-measurement or perf-overhead (e30565ee, 478c68fc, da321de5 twice);
the misses were the skill family's own authoring session (78335b17) and an order-bench API
compatibility run (d8674be5). `perf-measurement` loaded 8 times. Fix: one sentence in
`perf-evidence.md` pointing at the Skill tool with `perf-measurement` for the measurement
plan (and the perf-* family for the change). Destination: rules engine.

### 5. `pushback` tiers miss "stop"

"stop ingest" (cd2243b5) matched neither `pushback` nor `pushback-undo`. Fix: add `stop` to
the `pushback-undo` alternation. Destination: rules engine. The ledger is otherwise empty
because the rules landed 2026-09-18 and no correction opener was typed after that date.

### 6. Attribution correction repeated three times before its memory existed

"remove claude code attributions" was typed twice on 2026-09-14 (2da15f9e) and recurred on
2026-09-16 across 8 commits and 7 PR footers before `no-commit-attribution.md` was written in
the trading-framework project memory. The harness now appends a `Claude-Session:` line to
every commit in every repo. If the preference is global, it belongs as one line in
`~/.claude/CLAUDE.md`; a project memory only protects one repo. Destination: global
instructions file, pending the user's answer on scope.

### 7. `retro-scan` keyword map: `stale` is too broad for `agent-status`

18 agent-status gaps; 5 of 6 sampled were "stale data", "stale records", "stale worktrees" or
Next.js ISR staleness (649e52cc, a9915154, 73c2a7cc, 0f0b112c, 8afceaa5). The one real match
("verify states", 882b57b0) predates the skill (created 2026-09-16), as do both disk-cleanup
gaps. Fix: narrow the keyword to the skill's own phrases ("seems stale", "stuck", "verify
states"). Destination: this repo, `retro-scan.ts`.

### 8. Repeat from the 2026-09-09 retro: `in-progress/` still holds nine unused skills

claude-handoff, implement-spec, loop-me, pr, retro, setup-ts-deep-modules, writing-beats,
writing-fragments, writing-shape. All `disable-model-invocation`, none typed in this window
(the `retro` count is `howardism/retro`; the linker skips the bucket). The previous retro
named six as `deprecated/` candidates and nobody moved them. Destination: this repo.

## Applied 2026-09-24

Findings 1, 2, 3, 4, 5, 7 and 8 were approved; 6 was answered as trading-framework only, so
the project memory stands and nothing global changed.

| Where | Change |
|---|---|
| rules engine | `babysit-skill.md` (new): leading `babysit` calls the Skill tool with `rebase-babysit` |
| rules engine | `research-skill.md` (new): leading `research` calls the Skill tool with `research`, with an inline escape for quick lookups |
| rules engine | `agent-docs-skill.md` (new, Bash-only): a shell write into SKILL.md, CLAUDE.md or AGENTS.md injects a once-per-session pointer to `writing-for-agents` |
| rules engine | `perf-evidence.md`: names `perf-measurement` and the perf-* family |
| rules engine | `pushback-undo.md`: `stop` added to the trigger alternation |
| rules engine | `CLAUDE.md` hook mechanics: the PreToolUse match-subject limitation below |
| this repo | `retro-scan.ts`: agent-status keyword `stale` narrowed to `seems stale` |
| this repo | six `in-progress/` skills moved to `deprecated/`, both bucket READMEs updated, `codebase-design.md` cross-reference fixed, changeset added |

`bun rules-engine/selfcheck.ts` passes; the corpus has no cases for the new ids, so the pass
proves parse and no regression, not firing. The scan script was smoke-run over a 3-day window.

### Found while applying

Finding 3 landed narrower than proposed. A `PreToolUse` `match` is tested only against
`tool_input.command`; `Edit` and `Write` carry no `command`, so their subject is the empty
string and no regex can fire on a file path. The rule is honest about that (`tool: ^Bash$`)
and catches heredoc, redirect, `sed -i`, `tee`, `cp`, `mv` and `git apply` writes only. Of the
six verified gap sessions, one was a heredoc; the Edit-tool cases stay uncovered until
`engine.ts` threads `file_path` into the match subject for non-Bash tools. Recorded in the
rules-engine repo's `CLAUDE.md`.

## Recorded, no action

- **Commit and apply phrases are the workflow, not redone work.** All 20 repeat clusters
  verified as distinct tasks across repos; two were parallel dispatch minutes apart (items 13,
  19) and one a single-session bench retry loop (e4fc4553). "create atomic commits and PR" and
  its variants total about 26 prompts; `commit-contract` landed 2026-09-23 and has fired six
  times. Baseline for the next retro: `commit-with-subagent` 15 loads against 69 keyword gaps
  this window. `workflow-apply` fires about 90 times a month and needs nothing.
- **Nudges are not friction.** 10 of 12 sampled `continue`/`resume` sessions followed a 529,
  401 or ENOTFOUND error, a spend limit, a machine sleep, or an immediate re-run of a finished
  report. The two genuine stops: a disk-full session (12c68567; `disk-cleanup` now exists) and
  a turn that ended while a CI babysit agent was still running (ace22bf3).
- **One-off corrections with no rule earned**: stale claude-mem references after an uninstall
  (18a0d077), DB over seed fixtures (0f0b112c), a stray `./~` directory from an unexpanded
  literal tilde (c24e161a), prefer opening a PR over sending a message (1d4c8837). Each once.
- **Long prompts** (13): pasted logs, tables, terminal output, one pasted diagram style guide.
  No re-explained instruction set.
- **Previous retro's proposals**: H1, H2 (narrowed), H3 (`subagent-worker-contract`, 89
  firings), S1', S2, S3, S4, the skill-usage table and the noise-filter ordering all landed.
  `subagent-routing` went from 3 loads to 62.

# Retro: skills usage, 2026-08-10 to 2026-09-09

Scope: 30-day prompt scan (2,184 rows, 1,066 after noise filter) plus an all-time
invocation tally over `~/.claude/projects` and `~/.codex/sessions`.

Usage was measured from the `Base directory for this skill: <path>` banner Claude Code
prints when a skill loads. Codex does not print it, so `codex-*` skills are unmeasurable
this way and are excluded from every "never fired" count below.

## What actually gets used (all time)

| Skill | Fires |
|---|---|
| rebase-babysit | 123 |
| perf-measurement | 64 |
| chat-history | 64 |
| retro | 45 |
| writing-for-agents | 42 |
| implement-plan-with-sonnet (renamed) | 30 |
| perf-overhead / perf-algorithms / perf-review / perf-memory / perf-api | 22 / 21 / 20 / 18 / 16 |
| handoff | 13 |
| commit-and-pr-with-sonnet (renamed) | 9 |
| resolving-merge-conflicts | 8 |
| grilling | 7 |
| refine-skill | 5 |
| commit-with-subagent | 4 |
| subagent-routing / research / obsidian-vault / fewer-permission-prompts | 3 each |
| edit-article / code-review | 1 each |

The perf-* family is the best-earning group in the repo: six skills, 161 combined fires.

## Findings

### 1. 34 of 55 installed skills have never fired

26 of them predate 2026-08-21, so age is not the explanation.

- **Upstream-tracked** (`engineering/`, `productivity/`): ask-matt, tdd, triage, implement,
  prototype, codebase-design, diagnosing-bugs, domain-modeling, to-spec, to-tickets,
  wayfinder, wizard, setup-matt-pocock-skills, improve-codebase-architecture, grill-me,
  grill-with-docs, teach, to-questionnaire, wait-what. Deleting these creates rebase
  conflicts against the fork, so the answer is not deletion.
- **Repo-owned** (`in-progress/`): writing-beats, writing-fragments, writing-shape (all
  2026-05-06), loop-me (2026-06-24), claude-handoff (2026-07-02), setup-ts-deep-modules (2026-07-10), implement-spec (2026-08-21). All seven are
  `disable-model-invocation: true`, so zero fires means never typed once. Six are 6+ weeks
  old. Candidates for `deprecated/`.
- The eight howardism skills that landed in the 2026-09-08 consolidation commit
  (afk-issue-loop, blindspot, bun-workspace-quality, codex-fewer-permission-prompts,
  codex-refine-harness, find-skills, implement-with-subagent, refine-harness) are too new
  to judge.

### 2. `ask-matt` is a router with zero recorded uses and a standing maintenance tax

`CLAUDE.md` requires re-reading and updating `ask-matt/SKILL.md` on every add, rename,
removal, or routing change to a user-reachable skill. It has never been invoked. It is also
`disable-model-invocation: true`, so the model can never reach for it when a routing question
comes up. Either drop the mandate to something cheaper, or make it model-invocable so the
maintenance buys something.

### 3. "Audit my skill usage" was asked three times in nine days, and `retro` has no recipe for it

- 2026-08-31 `review skill usage in /chat-history and propose improvements`
- 2026-09-08 `use /chat-history and /refine-skill`
- 2026-09-08 `read /chat-history and run /retro on recent skills usage and propose improvements`

`retro` mines *prompts*; `refine-skill` tallies fires for *one* named skill. Nothing tallies
the portfolio, so this scan hand-rolled it. The recipe that produced the table above:

```bash
rg -oI --no-filename 'Base directory for this skill: [^"\\ ]+' ~/.claude/projects ~/.codex/sessions \
  | sed 's|.*/||' | sort | uniq -c | sort -rn
```

Belongs in `retro`'s Gather step.

### 4. `retro`'s noise filter drops the rows that measure skill usage

The Noise filter lists `Base directory for this skill:` under **Expansions** to drop, while
its own intro says to tally those expansions separately. Filtering first and tallying second
loses them; this scan hit exactly that and had to re-derive from the unfiltered dump. Needs
an ordering note.

### 5. `chat-history prompts` cannot see slash-command invocations at all

Messages starting with `<` are skipped, which includes the `<command-name>` wrappers a slash
invocation produces. A leading-slash tally over 1,066 filtered rows returned 4. This is *why*
the load banner is the only usage signal, and the `prompts` docs do not say so.

### 6. `skill-creator`'s eval scores only the first tool call, and `refine-skill` does not warn

Verified in `run_eval.py`: the assistant-message branch returns after inspecting the first
`tool_use` block, and the streaming branch returns `False` on the first non-matching tool. Any
realistic query where the model reads a file or runs a command before invoking the skill scores
as "not triggered".

The user asked for eval-backed skill edits repeatedly ("verify with /skill-creator",
"apply with eval", "apply all with /skill-creator evals", "apply all fixes and eval each change
one by one" across four sessions), yet `refine-skill` step 4 routes only to `writing-for-agents`
and never mentions evals or this trap. The gotcha currently lives in memory, not in the skill
that leads there.

## Checked and dismissed

- **27 `continue` + 9 `resume` nudges.** Not stopping-short. Session `f2de0c2f` shows them
  following "You've hit your monthly spend limit" and "Your organization has disabled Claude
  subscription access"; others follow killed background sweeps.
- **`implement-plan-with-sonnet` (13) and `commit-and-pr-with-sonnet` (4) fires in-window.**
  All predate the 2026-09-08 rename. Both deploy dirs audited: 58 entries each, all symlinks,
  none dangling, no name outside the repo. No stale rename duplicate this time.

## Follow-up: subagent-delegation skills, reviewed with `refine-skill`

Grounding (step 1). None of `subagent-routing`, `implement-with-subagent`, or
`commit-with-subagent` appears in `skillOverrides`, so all three are model-visible. All
three descriptions fit the configured `skillListingMaxDescChars: 400` (273 / 300 / 222).
Every bundled part resolves: seven `references/*.md` under `subagent-routing`, an
`agents/openai.yaml` in each.

Usage. `subagent-routing` and the renamed pair are two days old (2026-09-08), so counts are
small and the direction, not the magnitude, is the signal.

| | Count |
|---|---|
| Sessions carrying the "read subagent-routing before delegating" mandate | 39 |
| Sessions that ran `cat ~/.agents/skills/subagent-routing/SKILL.md` | 4 |
| Sessions that loaded it through the Skill tool (banner) | 3 |
| Sessions that did both | 1 |
| Distinct sessions that grounded routing at all | 6 |
| Sessions that loaded a delegation workflow skill (all time, both names) | 31 |
| ...of those, also grounded routing | 1 |

### S1. The mandate names a route that suppresses the skill's own wiring

Global `CLAUDE.md` and `~/.claude/rules/subagent-routing.md` both say to *read*
`~/.agents/skills/subagent-routing/SKILL.md`. Reading the file rather than invoking the skill:

- prints no base-directory banner, so the skill is invisible to every usage measurement,
  including `refine-skill`'s own grounding step;
- hands the model relative links (`references/claude.md`) with no resolved base, where the
  Skill tool prints the absolute base directory that makes them resolvable;
- points into the Codex pool (`~/.agents`) from inside Claude Code, which works only because
  both pools symlink to this repo.

Fix: make the global instruction call the Skill tool, and keep the file path as the Codex-only
fallback. Touches the user's global config.

### S2. The same instruction is stated in four places, and they already disagree

Global `CLAUDE.md`, `~/.claude/rules/subagent-routing.md` (a near-verbatim copy of that
bullet), this repo's `CLAUDE.md`, and the opening line of both workflow skills. Two say read a
file path, one says `/subagent-routing`. Duplication has not raised compliance and guarantees
drift. Fix: one global home plus the two workflow skills, which is where it is load-bearing.

### S3. `subagent-routing`'s description does not present it as a prerequisite

It reads as a standalone capability. Nothing tells the model that the two workflow skills
require it, and when the user says "implement this with a subagent" the workflow skill's
description matches far better and wins the listing. That matches the observed 1-of-5 overlap.
There is room to fix it: 273 of the 400-character budget is used.

### S4. Both workflow skills open with a bare slash reference

`Use /subagent-routing first.` A mid-sentence slash is not expanded by the harness. The
explicit form used elsewhere in this repo, "call the Skill tool with `subagent-routing`",
is unambiguous. `subagent-routing` itself already mixes both styles.

### S5. `implement-with-subagent` has 0 fires; `implement-plan-with-sonnet` had 25

Expected two days after the rename, and no action needed, but the repo has been bitten before
(`diagnose` outlived its rename to `diagnosing-bugs` by eleven days). Verified clean: 51
symlinks in each pool, no old-name entry in either.

### S6. Do not rewrite the prose yet

`refine-skill` puts "run it" before "edit the prose", and neither workflow skill has been run
once under its new name. Both are dense single-file constraint prose; whether that density is
a defect is settled by one real invocation, not by reading.

## Hook research: can a hook do this more cheaply than an instruction?

Yes, but not the hook shape currently installed. Three structural blockers, all verified.

### Correction to the compliance framing above

The 1-of-31 overlap is not evidence that the instruction route failed. `subagent-routing`
landed 2026-09-08, and the `workflow-apply` rule's pointer to it was added 2026-09-08 and is
still uncommitted (`git status` in the rules-engine repo shows `M rules/workflow-apply.md`).
There has been no fair trial. What follows are structural findings that hold regardless.

### The always-on cost, measured

| | |
|---|---|
| Main sessions in the last 30 days | 1,461 |
| ...that spawned an `Agent` at all | 175 (12%) |

The delegation mandate is loaded into all 1,461 through three always-on files: the `## Agent`
bullet in global `CLAUDE.md`, `~/.claude/rules/subagent-routing.md` (230 bytes, a near-verbatim
copy of that bullet), and this repo's `CLAUDE.md`. A hook rule costs nothing in the 88% of
sessions that never delegate. `agent-orchestration.md` (1,513 bytes) already demonstrates the
pattern: it is paid only at the first `Agent` spawn in a session.

### H1. The engine is blind to slash invocations

`engine.ts:747`:

```js
if (prompt.startsWith("<") || prompt.startsWith("/")) return;
```

Every `/implement-with-subagent`, `/commit-with-subagent`, and `/retro` bypasses **every**
`UserPromptSubmit` rule, including `workflow-apply`, the rule written specifically to enforce
delegation. The comment says this is deliberate ("keyword rules are for prompts the user
actually typed"), and for keyword matching it is right. But it means the moment a delegation
skill is invoked by name is the one moment no rule can observe.

`UserPromptExpansion` is the event for this: it fires when a user-typed command or skill
expands, before the expanded prompt reaches the model, its matcher is the command name, and it
supports both `additionalContext` and `updatedInput`. Neither `engine.ts`, `selfcheck.ts`, nor
`settings.json` mentions it. Adding it is the single highest-leverage change here, and it makes
S1 and S4 unnecessary: the routing reference arrives mechanically instead of by instruction.

### H2. `PreToolUse` injection is too late for the spawn it matched

Per the hooks reference, `additionalContext` on `PreToolUse` does not reach the model before
the current tool call; it lands afterwards. So `agent-orchestration.md` (`once: session`,
`action: inject`, `tool: ^(Agent|Task)$`) shapes the *second* spawn of a session and never the
first. This is consistent with the engine's own design: `agent-model` needs to affect the call
it matched, and it uses `action: deny` with the text carried in `permissionDecisionReason`,
which costs a turn. This claim is documentation-sourced and worth one live test before acting
on it.

`updatedInput` is the untried third option: a `PreToolUse` rule could write the ownership
contract straight into the worker's prompt rather than asking the caller to have read it. The
engine uses `updatedInput` zero times.

### H3. Split caller-side from worker-side

`SubagentStart` injection is free, reliable, and already in use (`sandbox-worktree-subagent`).
Everything the **worker** must know (ownership, validation duties, the result contract from
`references/common.md`) belongs there. Everything the **caller** must know (which harness,
which model tier, from `references/claude.md`) cannot be delivered that way and has to arrive
at `UserPromptExpansion` or `UserPromptSubmit`. The two references already split cleanly along
this line, and `agent-orchestration.md` does not duplicate `references/claude.md`: the rule
covers spawn mechanics, the reference covers model and effort selection.

### H4. The engine cannot tell whether routing was grounded

There is no `Skill` matcher in `settings.json` and no occurrence of `Skill` in `engine.ts`, so
a "deny the spawn unless `subagent-routing` was read" gate is not currently expressible. It
would need a `PreToolUse` matcher on `Skill`, a `SessionState` flag, and a `special` handler.
Given H1, injecting at expansion time is cheaper than gating at spawn time and needs no new
state.

## Revised proposals

| | Proposal | Where | Status |
|---|---|---|---|
| H1 | Add a `UserPromptExpansion` handler to the engine plus a `settings.json` matcher, and a rule keyed on the delegation skill names that injects the routing reference at expansion | `engine.ts`, `settings.json`, new `rules/*.md` | new, highest leverage |
| H2 | Test whether `PreToolUse` `additionalContext` reaches the current call; if not, move `agent-orchestration` to `deny` or `updatedInput` | `rules/agent-orchestration.md` | new, test first |
| H3 | Move the common contract to a `SubagentStart` rule; keep harness and model selection caller-side | new `rules/*.md` | new |
| S1' | Delete `~/.claude/rules/subagent-routing.md` and the routing sentence from the global `CLAUDE.md` `## Agent` bullet once H1 lands | global config | revised: delete, do not re-word |
| S2 | Collapse the four-way duplication to one hook rule plus the two skills | global config | stands |
| S3 | Rewrite `subagent-routing`'s description to lead with the prerequisite framing (273 of 400 chars used) | `subagent-routing/SKILL.md` | stands |
| S4 | Replace the bare `/subagent-routing` slash in both workflow skills | both `SKILL.md`s | superseded by H1, still correct |

## Applied 2026-09-09, with what the experiments changed

Four hook facts were established by live experiment before any code was written. Two of them
contradict or are absent from the documentation, and two of them narrowed the plan.

| Claim | Method | Result |
|---|---|---|
| `PreToolUse` `additionalContext` shapes the call it matched | probe hook on `Agent` emitting a marker | **False.** The marker reached the caller attached to the tool result, spawn already dispatched. `agent-orchestration` shapes spawn #2, never #1. |
| That context also reaches the worker | asked the probe agent whether it saw the marker | **False.** It reported no. Worker-side content must ride `SubagentStart`. |
| `UserPromptExpansion` fires when a skill is invoked | dumper hook on that event across a `Skill` call | **False.** Nothing captured. It fires only for user-typed commands, so it cannot cover the path where the model reaches for a skill itself. |
| Its payload schema is documented | docs fetch | **No.** Undocumented, and uncapturable for the reason above. |

### What that changed

- **H1 narrowed.** The `UserPromptExpansion` handler was still built, because a typed
  `/implement-with-subagent` is a real case, but it cannot be the general enforcement point.
  The handler resolves the command name and expanded text from a candidate list of field names and
  always writes an audit row naming the keys actually present, so the first real firing
  self-documents the schema. Tighten it once a real row exists.
- **S1' revised again.** The plan said delete the always-on line once H1 landed. Because H1 cannot
  see model-invoked skills, one always-on line has to stay. It was rewritten to the Skill-tool
  route instead, and the duplicate `~/.claude/rules/subagent-routing.md` was deleted.
- **H2 sharpened.** Rather than converting all of `agent-orchestration` to a deny, only the
  first-spawn-critical clause (the nested-worktree ban) became one, gated on `state.inWorktree`
  plus `isolation: "worktree"`. The rest stays an inject, which is correct for post-spawn guidance.

### Found while applying

The uncommitted edit to global `CLAUDE.md` had replaced the model-tier list in the `## Agent`
bullet with the routing pointer, which left `rules/agent-model.md` telling the model to "pick the
tier by the Agent section of CLAUDE.md" when that section no longer holds tiers. Repointed it at
the running-harness reference.

### Delta

| File | Change |
|---|---|
| `scripts/link-skills.sh` | skips `in-progress/`; local deviation from upstream, documented |
| `CLAUDE.md` (this repo) | `ask-matt` mandate softened; `in-progress/` deviation and the linker's never-prunes behaviour recorded; the restated delegation mandate replaced with repo-ownership facts |
| `~/.claude/skills`, `~/.agents/skills` | 7 orphaned `in-progress/` symlinks removed from each, 58 to 51 |
| `subagent-routing/SKILL.md` | description leads with the prerequisite framing, names both dependents (336 of 400 chars) |
| `implement-with-subagent`, `commit-with-subagent` | bare slash references replaced with the explicit Skill-tool form |
| `agent-plugins/claude/CLAUDE.md` | `## Agent` bullet routed through the Skill tool |
| `agent-plugins/CLAUDE.md` | verified hook mechanics recorded |
| `agent-plugins/rules-engine/rules/agent-model.md` | repointed at the harness reference |
| `~/.claude/rules/subagent-routing.md` | deleted (duplicate of the global bullet) |
