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
