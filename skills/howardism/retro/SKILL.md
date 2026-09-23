---
name: retro
description: Retrospective over past Claude session history to improve prompt quality and reusability. Use when the user says "retro", "/retro", "review my prompts", "what keeps repeating", or wants session history mined for recurring prompts, friction, and skill/CLAUDE.md improvements.
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

The script runs chat-history's `chatlog prompts` (the transcript parser, guarded by its `selfcheck`), applies the noise filter, and prints: the push-back ledger, skill usage (typed `/x` vs assistant-loaded), keyword→skill gaps, correction openers, nudges, repeated prompts, long prompts, Stop-hook goals, and hand-typed prompts per project. `--briefs $R` also writes `brief-<bucket>.md` per non-empty verification bucket (nudges, corrections, gaps, repeats), each a complete read-only worker brief: the question, the chatlog commands, the items, and the verdict file to write. A bucket over 24 items splits into `-1`, `-2` parts (`--per-brief N`). `--prompts <file>` reuses a saved `chatlog prompts --width 0` dump. `--cap` bounds each list. The scan is ~22 KB for a 30-day window; read it at root, it is the evidence. Transcript output of any size stays out of root: that is what step 2 is for.

**Noise filter** lives in the script: `HARNESS_ROWS` (interrupts, images, continuations, idle notices, stopped background agents), `COMMAND_BODIES` (built-in and vault command bodies that land as user turns without a marker), harness projects (every session holds exactly one prompt: the home-dir cwd, `/private/tmp`, eval fixtures). Skill bodies arrive as `[skill:x]` or `[/x args]` marker rows from chatlog. When a "repeat" in the output turns out to be a command body or an automation echo (cron, `/loop`, ScheduleWakeup: identical long imperative prompts at regular intervals), add its prefix to `COMMAND_BODIES` and rerun; count the hand-typed bootstrap once. Fork echoes (one prompt under two session ids in the same minute inside a `--claude-worktrees-` project) are one prompt.

**Push-back ledger**: the rules engine appends a row to `~/.claude/rules-engine-state/audit.jsonl` for every prompt that opens as a correction (`pushback`, `pushback-undo`, rows since 2026-09-18) and for every turn Claude opened by conceding (`pushback-conceded`). A concession row is the higher-value find: its prompt usually did not read as a correction. `pushback-undo` is the noisier tier (about 40% genuine). Zero rows over a short window is normal; the script's correction-opener list (a wider regex) is the fallback. The ledger keeps the newest half of a 5 MB cap (about 38 days), so longer windows rely on the opener list. A `cwd` recurring across sessions is a standing-rule gap, not a one-off.

## 2. Verify with parallel workers

Every candidate whose cause lives in a transcript (why a nudge, what a correction corrected, whether a gap was real, whether a repeat was re-done work) is answered by a worker, never by a `show` at root: one verification is 8 to 13 transcript reads of 20 to 90 KB each, and the retro needs one line per item back. The buckets are independent, so they run at once.

Call the Skill tool with `subagent-routing`, then spawn one general-purpose worker per brief file in a single message, nameless, with an explicit `model: sonnet` (the worker judges, not just extracts), and the prompt `Read and follow <absolute path to brief-<bucket>.md>`. The brief already carries the role, the tools, the items, and the deliverable: each worker writes `verdicts-<bucket>.md` beside its brief and replies with the count and the path. Five briefs is the harness fan-out gate; a sixth and beyond run after the first batch reports.

While the workers run, do the root work that needs no verdicts: read the previous `retro-notes.md` in the cwd (proposals never applied are reported again as repeats), and read `scan.md`'s skill table and long-prompt list. When every worker has reported, `cat $R/verdicts-*.md`; a worker's line is evidence to carry forward with its sid, and a transcript is opened at root only to settle a verdict that contradicts the scan.

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

Present a short table: finding, evidence (count + example prompt), proposed fix, destination (new skill / instructions file / memory note). Write the ranked findings with evidence to `retro-notes.md` in the cwd (look at the existing one first; it records the last retro's proposals, and a plain overwrite loses them silently). Then ask which to apply. Writes to the global instructions file, the skills dir, or memory are user-visible config changes, so confirm before writing. Apply the approved ones:

Harness paths: Claude Code uses `~/.claude/CLAUDE.md` and `~/.claude/skills/`; Codex uses `~/.codex/AGENTS.md` and `~/.agents/skills/`.

- **Skill**: write it with **`writing-for-agents`** (always present, since it ships in this repo); `skill-creator:skill-creator` is the richer alternative when that plugin is installed. Project-local unless the pattern spans projects → the global skills dir.
- **Rule**: a rules-engine rule when the trigger is a prompt or tool pattern (it fires without spending context); otherwise append to the matching section of the global instructions file (or the project's own if project-specific).
- **Memory**: follow the harness's active memory instructions; do not edit the memory registry directly.

An approved list usually lands in two to four repos (skills, rules engine, a project's own config, memory). The root applies memory and single-file edits itself. Everything else goes through **`implement-with-subagent`**, one write-enabled worker per repo, each briefed with the finding, the approved fix, and the destination file, running at once because each repo's index has one owner. Workers never commit; when the user asks for commits, hand the whole set to **`commit-with-subagent`**. Verify each worker's diff against the finding before reporting it applied.

Finish with a one-line delta summary: what was created/changed.
