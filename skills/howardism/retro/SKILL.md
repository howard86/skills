---
name: retro
description: Retrospective over past Claude session history to improve prompt quality and reusability. Use when the user says "retro", "/retro", "review my prompts", "what keeps repeating", or wants session history mined for recurring prompts, friction, and skill/CLAUDE.md improvements.
---

# Retro

Mine past session transcripts (global paths) for recurring prompts and friction, then propose concrete improvements: new skills, CLAUDE.md rules, memories.

## Scope

Default: last 30 days, all projects. Args override: `/retro 7d`, `/retro all`, `/retro <project-substring>`.

## 1. Gather

All data is global regardless of cwd. Use the chat-history skill's script — it owns the transcript parsers, guarded by its `selfcheck`:

```bash
# chat-history's own script, not retro's — ${CLAUDE_SKILL_DIR} only resolves within chat-history itself
S=~/.claude/skills/chat-history/scripts/chatlog.ts   # Codex: ~/.agents/skills/chat-history/scripts/chatlog.ts
bun $S prompts --days 30 [--project sub]     # every user prompt: [time project sess-id] text
```

Map scope args to flags: `/retro 7d` → `--days 7`, `/retro all` → a `--days` window covering the whole corpus (the scan reads transcripts directly, so cost scales with the window), project substring → `--project`.

**Conversational context** (what went wrong after a prompt): `bun $S show <sess-id> --grep <term>`, add `--tools` for the exact commands/errors. Full-text lookup across transcripts: `bun $S search <query>`. Don't bulk-read raw transcripts; they're large.

For large scopes, fan out one Explore/general-purpose agent (Sonnet) per project group instead of reading everything inline.

## 2. Analyze

Look for, in priority order:

1. **Repeated prompts** — same request typed ≥3 times (exact or paraphrased) → skill or slash-command candidate.
2. **Corrections** — user follow-ups like "no, ...", "actually", "I meant", "don't do X" → a missing standing rule (CLAUDE.md or memory). Recurring corrections outrank one-offs.
3. **Long hand-written prompts** — detailed multi-paragraph instructions re-explained across sessions → skill with the instructions baked in.
4. **Re-done work** — the same task appearing solved in two sessions (`search` for its key terms across the window) → memory or reference doc gap.
5. **Prompt-quality anti-patterns** — vague asks that led to long clarification loops → suggest a sharper template.

Record every finding; filter at the report step, not during the scan. Per cluster, weigh recurrence against build cost — a 2× annoyance doesn't earn a skill; a 10× one does.

Automated prompts pollute the counts: cron-fired jobs, ScheduleWakeup self-prompts, and `/loop` repeats appear as user prompts. Identical long imperative prompts repeated at regular intervals are automation echoes — count the hand-typed bootstrap once, not every firing. `prompts` excludes subagent transcripts by default (agent-authored spawn briefs, not typed prompts — ~36% of rows in one sample), so its counts are already hand-typed prompts on top of that.

### Noise filter

Drop these before counting (2026-09-02 scan: 2,259 rows → ~910 hand-typed). Tally the slash-command expansions separately as skill usage, and count each babysit goal once per session — the quoted condition is the hand-typed prompt.

- **Harness projects** — a project where every session holds exactly one prompt is an eval or cron harness, not a person: the home-dir cwd (`-Users-howard86`, skill-eval fixtures repeated 15× each) and `-private-tmp-*`.
- **Harness rows** — `[Image:`, `[Request interrupted`, `This session is being continued`, `Stop hook feedback:`, `## Context Usage`, `The fork runs as its own separate session`, `<teammate-message`, `<command-message>`, `<local-command`.
- **Expansions** — `Base directory for this skill:`, `Skill /x is already loaded`, `# /loop —`, built-in bodies (`# Claude Code Doctor`, `# Fewer Permission Prompts`), vault command bodies (`Compile new raw documents`, `Audit the knowledge base`, `Scout ingest-ready`, `Ingest content from a URL`, `Distill actionable`, `Answer a research question`, `Close scoped alpha`, `Operate a worker fleet`), and any always-loaded project skill (vault-tooling appeared 71×).
- **Loops and goals** — `# Autonomous loop check`, `<<autonomous-loop-dynamic>>`, `Goal check-in:`; keep `A session-scoped Stop hook is now active with condition: "…"` but count the quoted goal, not the wrapper.
- **Fork echoes** — one prompt under two session ids in the same minute inside a `--claude-worktrees-` project is a fork, not re-done work.

Nudges (`continue`, `retry`, `resume`) are a friction signal only after checking what preceded them in the transcript: in the same scan 15 of 37 followed `API Error: 529 Overloaded` and several a spend-limit message.

## 3. Report & apply

Present a short table: finding, evidence (count + example prompt), proposed fix, destination (new skill / instructions file / memory note). If the user asked for a record (or the scan was large), also write the ranked findings with evidence to `retro-notes.md` in the cwd before asking. Then ask which to apply — writes to the global instructions file, the skills dir, or memory are user-visible config changes, so confirm before writing. Apply the approved ones:

Harness paths: Claude Code uses `~/.claude/CLAUDE.md` and `~/.claude/skills/`; Codex uses `~/.codex/AGENTS.md` and `~/.agents/skills/`.

- **Skill**: write it with **`writing-for-agents`** (always present — it ships in this repo); `skill-creator:skill-creator` is the richer alternative when that plugin is installed. Project-local unless the pattern spans projects → the global skills dir.
- **Rule**: append to the matching section of the global instructions file (or the project's own if project-specific).
- **Memory**: follow the harness's active memory instructions; do not edit the memory registry directly.

Finish with a one-line delta summary: what was created/changed.
