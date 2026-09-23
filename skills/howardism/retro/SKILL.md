---
name: retro
description: Retrospective over past Claude session history to improve prompt quality and reusability. Use when the user says "retro", "/retro", "review my prompts", "what keeps repeating", or wants session history mined for recurring prompts, friction, and skill/CLAUDE.md improvements.
---

# Retro

Mine past session transcripts (global paths) for recurring prompts and friction, then propose concrete improvements: new skills, rules, memories.

## Scope

Default: last 30 days, all projects. Args override: `/retro 7d` → `--days 7`, `/retro all` → a `--days` window covering the whole corpus (cost scales with the window), `/retro <project-substring>` → `--project sub`.

## 1. Scan

One command produces every evidence table; read its output instead of writing ad-hoc parsers:

```bash
S=~/.claude/skills/retro/scripts/retro-scan.ts   # Codex: ~/.agents/skills/retro/scripts/retro-scan.ts
bun $S --days 30 [--project sub] [--cap 12] > retro-scan.md
```

The script runs chat-history's `chatlog prompts` (the transcript parser, guarded by its `selfcheck`), applies the noise filter, and prints: the push-back ledger, skill usage (typed `/x` vs assistant-loaded), keyword→skill gaps, correction openers, nudges, repeated prompts, long prompts, Stop-hook goals, and hand-typed prompts per project. `--prompts <file>` reuses a saved `chatlog prompts --width 0` dump. `--cap` bounds each list.

**Noise filter** lives in the script: `HARNESS_ROWS` (interrupts, images, continuations, idle notices, stopped background agents), `COMMAND_BODIES` (built-in and vault command bodies that land as user turns without a marker), harness projects (every session holds exactly one prompt: the home-dir cwd, `/private/tmp`, eval fixtures). Skill bodies arrive as `[skill:x]` or `[/x args]` marker rows from chatlog. When a "repeat" in the output turns out to be a command body or an automation echo (cron, `/loop`, ScheduleWakeup: identical long imperative prompts at regular intervals), add its prefix to `COMMAND_BODIES` and rerun; count the hand-typed bootstrap once. Fork echoes (one prompt under two session ids in the same minute inside a `--claude-worktrees-` project) are one prompt.

**Push-back ledger**: the rules engine appends a row to `~/.claude/rules-engine-state/audit.jsonl` for every prompt that opens as a correction (`pushback`, `pushback-undo`, rows since 2026-09-18) and for every turn Claude opened by conceding (`pushback-conceded`). A concession row is the higher-value find: its prompt usually did not read as a correction. `pushback-undo` is the noisier tier (about 40% genuine). Zero rows over a short window is normal; the script's correction-opener list (a wider regex) is the fallback. The ledger keeps the newest half of a 5 MB cap (about 38 days), so longer windows rely on the opener list. A `cwd` recurring across sessions is a standing-rule gap, not a one-off.

## 2. Verify with one subagent

Every candidate whose cause lives in a transcript (why a nudge, what a correction corrected, whether a gap was real) goes to a single general-purpose subagent so the transcripts never enter this context. Call the Skill tool with `subagent-routing` first, then spawn one agent (the routing reference's reader-tier model) with this brief:

- Goal: return one line per item, `verdict: evidence (sid)`, nothing else.
- Tools: `bun ~/.claude/skills/chat-history/scripts/chatlog.ts show <sid> --grep <re> [--tools]` for context around a prompt; `chatlog search <query> --days N` for re-done work. Never dump a whole transcript.
- Items, pasted from `retro-scan.md`:
  - each nudge session: what preceded the `resume`/`continue` (`API Error: 529`, a spend or usage limit, sleep, or a genuine mid-task stop; only the last is friction);
  - each correction: what the previous turn did, and whether a CLAUDE.md line, rule, or memory already covers it (name it);
  - each keyword→skill gap, up to the cap: would the skill have applied, or was the keyword incidental;
  - re-done work: for each repeated-prompt cluster, `search` its key terms and say whether two sessions solved the same task.

Fan out more than one agent only when the window exceeds 90 days or spans more than three project groups; then one agent per group, same brief.

## 3. Analyze

With the scan and the verdicts, look for, in priority order:

1. **Repeated prompts**: same request typed ≥3 times (exact or paraphrased) → skill or slash-command candidate.
2. **Corrections**: ledger rows plus verified opener rows → a missing standing rule (CLAUDE.md or memory). Recurring corrections outrank one-offs.
3. **Skill usage**: a skill with zero loads whose keyword gaps are real is a pointer problem (sharpen its description or add a rule that names it); a skill loaded only by the assistant that the user keeps describing by hand ("create atomic commits and PR") wants a rules-engine trigger; a mid-sentence `/x` mention with nothing loaded after it is a `skill-mention` miss.
4. **Long hand-written prompts**: detailed instructions re-explained across sessions → skill with the instructions baked in.
5. **Re-done work**: the same task solved in two sessions → memory or reference doc gap.
6. **Prompt-quality anti-patterns**: vague asks that led to long clarification loops → suggest a sharper template.

Record every finding; filter at the report step, not during the scan. Per cluster, weigh recurrence against build cost: a 2× annoyance doesn't earn a skill; a 10× one does. Check the previous `retro-notes.md` in the cwd: a finding proposed there and never applied is reported again, marked as a repeat.

## 4. Report & apply

Present a short table: finding, evidence (count + example prompt), proposed fix, destination (new skill / instructions file / memory note). Write the ranked findings with evidence to `retro-notes.md` in the cwd (look at the existing one first; it records the last retro's proposals). Then ask which to apply. Writes to the global instructions file, the skills dir, or memory are user-visible config changes, so confirm before writing. Apply the approved ones:

Harness paths: Claude Code uses `~/.claude/CLAUDE.md` and `~/.claude/skills/`; Codex uses `~/.codex/AGENTS.md` and `~/.agents/skills/`.

- **Skill**: write it with **`writing-for-agents`** (always present, since it ships in this repo); `skill-creator:skill-creator` is the richer alternative when that plugin is installed. Project-local unless the pattern spans projects → the global skills dir.
- **Rule**: a rules-engine rule when the trigger is a prompt or tool pattern (it fires without spending context); otherwise append to the matching section of the global instructions file (or the project's own if project-specific).
- **Memory**: follow the harness's active memory instructions; do not edit the memory registry directly.

Finish with a one-line delta summary: what was created/changed.
