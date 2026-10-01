---
name: retro
description: Mine past session transcripts for recurring prompts and friction, then propose skills, rules, and memories that would remove them.
disable-model-invocation: true
---

# Retro

Mine past session transcripts (global paths) for recurring prompts and friction, then propose concrete improvements: new skills, rules, memories.

## Scope

Default: last 30 days, all projects. Args override: `/retro 7d` → `--days 7`, `/retro all` → a `--days` window covering the whole corpus (cost scales with the window), `/retro <project-substring>` → `--project sub`.

## 1. Scan

One command produces every evidence table and the worker briefs for step 2; read its output instead of writing ad-hoc parsers:

```bash
S=~/.claude/skills/retro/scripts/retro-scan.ts   # Codex: ~/.agents/skills/retro/scripts/retro-scan.ts
R=<scratchpad>/retro && mkdir -p $R               # the session scratchpad; a redirect into a missing dir fails before the script runs
bun $S --days 30 [--project sub] [--cap 12] --briefs $R > $R/scan.md
```

The script runs chat-history's `chatlog prompts` (the transcript parser, guarded by its `selfcheck`), applies the noise filter, and prints: the push-back ledger, skill usage (typed `/x`, assistant-loaded at root, and loaded inside workers; `loaded` counts root sessions only while `worker` counts subagent transcripts), keyword→skill gaps, correction openers, nudges, repeated prompts, long prompts, Stop-hook goals, and hand-typed prompts per project. `--briefs $R` also writes `brief-<bucket>.md` per non-empty verification bucket (nudges, corrections, gaps, repeats), each a complete read-only worker brief: the question, the chatlog commands, the items, and the verdict file to write. A bucket over 24 items splits into `-1`, `-2` parts (`--per-brief N`). `--briefs` also writes `items.jsonl` beside them: one row per brief item, in brief order (brief file, index, bucket, skill, ts, sid, project, text, `regex`, the Jev probability, the Jev model, `settled`), plus the settled items that never reach a brief. It is the input of `retro-calibrate.ts` in step 2. `--prompts <file>` reuses a saved `chatlog prompts --include-agents --width 0` dump (without `--include-agents` the `worker` column reads 0). `--cap` bounds each list. The scan is ~22 KB for a 30-day window; read it at root, it is the evidence. Transcript output of any size stays out of root: that is what step 2 is for.

**Jev path**: when the `jev-decisions` helper resolves and its key loads, the scan also asks Jev per hand-typed prompt whether it is a correction, a nudge, or asks for a keyword skill's job; the header's `jev:` line says whether it ran, and `--no-jev` forces the regex-only scan. Each bucket prints `regex N / jev M (both K, regex-only A, jev-only B)` with up to `--cap` rows each side missed: read those to judge the calibration before trusting either count. Brief items are the union, tagged `(regex)`, `(jev)`, or `(both)`, plus `(jev 0.63, verify)` for a 0.5 to 0.8 answer the worker settles like any other item. Prompts of five words or fewer reach Jev with `previous_reply` (the assistant text just before them, from `chatlog prompts --prev`), so a bare "babysit" or "verify states" keeps its referent; the questions tell Jev to read it only for that. The report ends with a `jev cost:` line (requests, input tokens, dollars), and the `jev:` line names the Jev model.

**Settling** (gaps bucket only): a gap item whose Jev `wanted_skill` is that skill at `>= 0.8` is settled. It stays out of the worker briefs, and `scan.md` lists it per skill under `settled by jev` so you can spot-check it. Every 5th settled item (the first, then the 6th, ...) still goes to a brief tagged `(jev 0.93, audit)`, so the top band keeps getting labels. Regex-only rows and the 0.5 to 0.8 band still go to workers. `--jev-act <x>` moves the threshold, `--verify-all` disables settling. Without Jev (`--no-jev`, no key) nothing is settled and the briefs are the regex-only ones.

**Noise filter** lives in the script: `HARNESS_ROWS` (interrupts, images, continuations, idle notices, stopped background agents), `COMMAND_BODIES` (built-in and vault command bodies that land as user turns without a marker), harness projects (every session holds exactly one prompt: the home-dir cwd, `/private/tmp`, eval fixtures). Skill bodies arrive as `[skill:x]` or `[/x args]` marker rows from chatlog. A `/loop` or ScheduleWakeup tick re-sends the user's prompt verbatim as a user turn, so the script drops a prompt of 150+ characters that recurs 3+ times in one session (`dropAutomationEchoes`, count on the stderr `dropped N automation echoes` line) and keeps the first as the hand-typed bootstrap. When a "repeat" still turns out to be a command body or a script-issued prompt (cron, a `claude -p` wrapper such as `research-cycle.sh`), add its prefix to `COMMAND_BODIES` and rerun. Fork echoes (one prompt under two session ids in the same minute inside a `--claude-worktrees-` project) are one prompt.

**Push-back ledger**: the rules engine appends a row to `~/.claude/rules-engine-state/audit.jsonl` for every prompt that opens as a correction (`pushback`, `pushback-undo`, rows since 2026-09-18) and for every turn Claude opened by conceding (`pushback-conceded`). A concession row is the higher-value find: its prompt usually did not read as a correction. `pushback-undo` is the noisier tier (about 40% genuine). Zero rows over a short window is normal; the script's correction-opener list (a wider regex) is the fallback. The ledger keeps the newest half of a 5 MB cap (about 38 days), so longer windows rely on the opener list. A `cwd` recurring across sessions is a standing-rule gap, not a one-off.

## 2. Verify with parallel workers

Every candidate whose cause lives in a transcript (why a nudge, what a correction corrected, whether a gap was real, whether a repeat was re-done work) is answered by a worker, never by a `show` at root: one verification is 8 to 13 transcript reads of 20 to 90 KB each, and the retro needs one line per item back. The buckets are independent, so they run at once.

Call the Skill tool with `subagent-routing`, then spawn one general-purpose worker per brief file in a single message, nameless, with an explicit `model: sonnet` (the worker judges, not just extracts), and the prompt `Read and follow <absolute path to brief-<bucket>.md>`. The brief already carries the role, the tools, the items, and the deliverable: each worker writes `verdicts-<bucket>.md` beside its brief and replies with the count and the path. Five briefs is the harness fan-out gate; a sixth and beyond run after the first batch reports.

While the workers run, do the root work that needs no verdicts: read the previous `retro-notes.md` in the cwd (proposals never applied are reported again as repeats), and read `scan.md`'s skill table and long-prompt list. When every worker has reported, `cat $R/verdicts-*.md`; a worker's line is evidence to carry forward with its sid, and a transcript is opened at root only to settle a verdict that contradicts the scan.

Before writing findings, run `bun ~/.claude/skills/retro/scripts/retro-calibrate.ts $R` (Codex: `~/.agents/skills/...`). It joins `items.jsonl` with the verdict files (a count mismatch per file fails loudly), appends the labelled rows to `${XDG_STATE_HOME:-~/.local/state}/retro/labels.jsonl` (deduplicated by bucket, sid, ts, skill; `--store <path>` overrides), and prints Jev's precision per bucket and model in the bands `>= 0.8`, `0.5 to 0.8`, and below 0.5 or 0, plus the lowest threshold whose precision reaches `--target` (default 0.85) over at least `--min-n` items (default 10), or `not enough labels`. Only the gaps bucket is scored (`applies*` is yes; `incidental`, `marginal`, `not-a-gap` are no); other buckets are stored with their raw label and counted. When the printed threshold differs from 0.8, pass it as `--jev-act` next time. The store holds prompt text: it stays out of every repo.

## 3. Analyze

With the scan and the verdicts, look for, in priority order:

1. **Repeated prompts**: same request typed ≥3 times (exact or paraphrased) → skill or slash-command candidate.
2. **Corrections**: ledger rows plus verified opener rows → a missing standing rule (CLAUDE.md or memory). Recurring corrections outrank one-offs.
3. **Skill usage**: a skill with zero loads whose keyword gaps are real is a pointer problem (sharpen its description or add a rule that names it); a skill loaded only by the assistant that the user keeps describing by hand ("create atomic commits and PR") wants a rules-engine trigger; a mid-sentence `/x` mention with nothing loaded after it is a `skill-mention` miss.
4. **Long hand-written prompts**: detailed instructions re-explained across sessions → skill with the instructions baked in.
5. **Re-done work**: the same task solved in two sessions → memory or reference doc gap.
6. **Prompt-quality anti-patterns**: vague asks that led to long clarification loops → suggest a sharper template.

Record every finding; filter at the report step, not during the scan. Per cluster, weigh recurrence against build cost: a 2× annoyance doesn't earn a skill; a 10× one does. A finding the previous `retro-notes.md` proposed and nobody applied is reported again, marked as a repeat.

## 4. Report & apply

Present a short table: finding, evidence (count + example prompt), proposed fix, destination (new skill / instructions file / memory note). Write the ranked findings with evidence to `retro-notes.md` in the cwd, with the scan's `jev cost:` line and the Jev model from its `jev:` line in the entry (look at the existing one first; it records the last retro's proposals, and a plain overwrite loses them silently). Then ask which to apply. Writes to the global instructions file, the skills dir, or memory are user-visible config changes, so confirm before writing. Apply the approved ones:

Harness paths: Claude Code uses `~/.claude/CLAUDE.md` and `~/.claude/skills/`; Codex uses `~/.codex/AGENTS.md` and `~/.agents/skills/`.

- **Skill**: write it with **`writing-for-agents`** (always present, since it ships in this repo); `skill-creator:skill-creator` is the richer alternative when that plugin is installed. Project-local unless the pattern spans projects → the global skills dir.
- **Rule**: a rules-engine rule when the trigger is a prompt or tool pattern (it fires without spending context); otherwise append to the matching section of the global instructions file (or the project's own if project-specific).
- **Memory**: follow the harness's active memory instructions; do not edit the memory registry directly.

An approved list usually lands in two to four repos (skills, rules engine, a project's own config, memory). The root applies memory and single-file edits itself. Everything else goes through **`implement-with-subagent`**, one write-enabled worker per repo, each briefed with the finding, the approved fix, and the destination file, running at once because each repo's index has one owner. Workers never commit; when the user asks for commits, hand the whole set to **`commit-with-subagent`**. Verify each worker's diff against the finding before reporting it applied.

Finish with a one-line delta summary: what was created/changed.
