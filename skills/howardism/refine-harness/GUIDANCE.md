---
checked: 2026-09-08
claude-code: 2.1.263
sources:
  - https://code.claude.com/docs/en/best-practices
  - https://code.claude.com/docs/en/memory
  - https://code.claude.com/docs/en/features-overview
  - https://code.claude.com/docs/en/skills
  - https://code.claude.com/docs/en/hooks
  - https://code.claude.com/docs/en/commands
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
---

# Guidance checks

Distilled from the sources above on the `checked` date. Each check is a test an item passes or
fails; the bracket names the source. Refresh when `checked` is older than 30 days or
`claude --version` has moved past `claude-code`: fetch every source, diff against these checks,
update both fields. (`anthropic.com/engineering/claude-code-best-practices` now redirects to the
first source.)

## C — any always-loaded line

CLAUDE.md lines, rule text, MEMORY.md index lines, model-invoked skill descriptions.

- **C1 Removal test.** "For each line, ask: Would removing this cause Claude to make mistakes?
  If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions."
  [best-practices]
- **C2 Default test.** "If Claude already does something correctly without the instruction,
  delete it or convert it to a hook." A no-op is model-relative: settle it by observing sessions,
  and record a judgement cut as a judgement. [best-practices]
- **C3 Derivable test.** Cut what Claude can find by reading code, config, or `--help`:
  directory layouts, dependency lists, architecture overviews, standard conventions. Keep
  pitfalls, rationale, and conventions that differ from tool defaults. `/doctor` (≥ 2.1.206)
  proposes these trims for a checked-in CLAUDE.md. [best-practices, memory]
- **C4 Tier test.** Every session → CLAUDE.md. Sometimes → a skill (on demand), a path-scoped
  `.claude/rules` file (`paths:` frontmatter), or a rules-engine moment rule. Every time, zero
  exceptions, no thinking needed → a hook. "An instruction like 'never edit .env' in CLAUDE.md
  is a request, not a guarantee." [features-overview, best-practices]
- **C5 Verifiable wording.** "Use 2-space indentation" over "Format code properly"; concrete
  enough that a reader can tell compliance from non-compliance. [memory]
- **C6 Motivation.** One clause of why; "Claude is smart enough to generalize from the
  explanation." A bare NEVER without a reason is the weaker form. [prompting]
- **C7 Positive form.** "Tell Claude what to do instead of what not to do." A prohibition earns
  its place only as a guardrail, paired with the positive target. [prompting]
- **C8 Emphasis budget.** "If Claude keeps skipping one instruction, add emphasis such as
  IMPORTANT to that line alone. If you emphasize many lines, none of them stands out."
  [best-practices]
- **C9 Consistency.** "If two rules contradict each other, Claude may pick one arbitrarily."
  Check across global CLAUDE.md, rules, memories, repo CLAUDE.md files, and the mirrors. [memory]
- **C10 Over-prompting.** "Instructions like 'If in doubt, use [tool]' will cause
  overtriggering"; "If your prompts previously encouraged the model to be more thorough or use
  tools more aggressively, dial back that guidance." Replace blanket defaults with a targeted
  condition. [prompting: Overthinking, Migration]
- **C11 Verification lines (Opus 5).** "If your prompt contains explicit verification
  instructions ('include a final verification step', 'use a subagent to verify'), remove them";
  "Avoid instructing re-checks it already performs ('double-check your answer')." [opus-5]
- **C12 Narration and formatting (Fable 5.1).** "Audit your prompt for instructions that
  suppress narration … Remove lines like that"; anti-formatting rules → "remove it or replace it
  with a rule that says when specific formatting is appropriate." Opus 5 is the opposite case:
  a short conciseness instruction is needed and effective. [fable-5.1, opus-5]
- **C13 Harness duplication.** Claude Code's own system prompt already carries model-specific
  blocks (progress-update cadence, autonomous completion, delivering-work scope, formatting).
  A CLAUDE.md line restating what is visible in the system prompt is duplication. [observed;
  compare against the system prompt in context]
- **C14 Maintainer notes.** Block-level `<!-- -->` comments in CLAUDE.md are stripped before
  injection: zero tokens for notes to humans. [memory]
- **C15 Size.** CLAUDE.md under 200 lines; MEMORY.md loads only its first 200 lines or 25 KB.
  Imports (`@path`) organise but still load at launch. [memory]
- **C16 Add-triggers.** A line earns its place when: Claude got it wrong twice; a review caught
  it; the same correction was typed last session; a new teammate would need it. One-off
  corrections stay in chat. [memory, features-overview]
- **C17 Compaction.** Conversation-only instructions vanish at `/compact`; project-root CLAUDE.md
  is re-read. A "when compacting, preserve …" line is the documented lever. [best-practices,
  memory]

## R — rules-engine rule (`$AP/rules-engine/rules/*.md`)

- **R1 Effect after firing.** "Habit rules are only worth keeping if behavior after the
  injection changes — check the transcripts, not the fire count." Fires-and-ignored → harden;
  fires-and-heeded → keep; zero fires and no deny value → cut. [$AP/README.md]
- **R2 False positives.** Every deny/ask sample in `detail` that was not the targeted behaviour
  → tighten `match`/`unless`, anchor at command position `(^|[;&|(]\s*|\$\(\s*)`, add the case
  to `corpus.json`. [$AP/README.md, memory rules-engine]
- **R3 Duplication with CLAUDE.md.** Subagents load CLAUDE.md too, so a rule whose text repeats a
  CLAUDE.md line is pure duplication (the `edit-discipline` precedent). [$AP/README.md]
- **R4 Injected text budget.** Rule text stays in context for the session; C1–C8 apply to it.
- **R5 Deny over prose.** A denied call with a reason changes behaviour deterministically where an
  injected reminder is advisory; use it when the wrong action is cheap to detect by regex and
  costly to let through. [$AP/README.md, features-overview]

## H — hooks (`$AP/claude/settings.json`)

- **H1 Target liveness.** The command's script exists and is executable; what it reads or prunes
  still exists (a SessionStart prune for a plugin now disabled is dead weight paid every start).
- **H2 Advisory → deterministic.** A "never/always" that must hold every time belongs in a
  PreToolUse deny, a Stop gate, or `permissions.deny`, not only in prose. [features-overview]
- **H3 Cost.** UserPromptSubmit hooks are capped at 30 s; `if:` filters are fail-open on
  commands the parser cannot decompose; the engine costs 10–30 ms per call; anything slow runs
  `async`. [hooks, $AP/README.md]
- **H4 Context cost.** A hook costs zero context unless it returns output; every injected line
  is paid like a CLAUDE.md line. [features-overview]

## M — auto memory (`~/.claude/projects/<project>/memory/`)

- **M1 Index cap.** Past 200 lines or 25 KB, entries never load; the write succeeds silently.
  [memory]
- **M2 Not-derivable, not-duplicated.** "Claude skips anything it can derive from the codebase …
  It also skips anything your CLAUDE.md files already say." A memory restating code, a rule, or
  a CLAUDE.md line → cut; a memory that is a repo fact → that repo's CLAUDE.md. [memory]
- **M3 Recall evidence.** A topic file never read in the window and describing finished work →
  cut, or fold its one live fact into the index line.
- **M4 Rule-shaped memory.** A `feedback` memory phrased "always/never do X" that was violated
  again is a standing rule → rules-engine rule (moment-scoped) or CLAUDE.md line; delete the
  memory. [features-overview add-triggers]
- **M5 Frontmatter.** `name`, `description`, `metadata.type` (user | feedback | project |
  reference); the harness stamps `modified` on write (≥ 2.1.214). Description is what recall
  ranks on. [memory]
- **M6 Subagents.** Main-session auto memory is not loaded into subagents (forks excepted);
  a fact subagents need lives in a rule or CLAUDE.md, not memory. [memory]

## S — skill listing (`~/.claude/skills`, `skillOverrides`)

- **S1 Listing cost.** Every model-invoked description loads on every request. "Use
  `disable-model-invocation: true` for skills with side effects. This saves context and ensures
  only you trigger them." A skill only ever typed by hand pays for nothing. [features-overview,
  skills]
- **S2 Cap.** The description is cut at `skillListingMaxDescChars` (400 here; default 1,536);
  trigger phrases past the cut are invisible — front-load or shorten. [skills, refine-skill]
- **S3 Overrides.** An override naming a skill that no longer exists is dead config; overrides
  never reach plugin skills — prune those from the plugin cache instead. [memory
  skills-architecture]
- **S4 Links.** A dangling symlink is an uninvokable skill; a real directory is a frozen copy
  that drifts silently. Relink from the skills repo's main checkout. [skills repo CLAUDE.md]
- **S5 Reports.** `/doctor` reports unused skills, MCP servers and plugins against their context
  cost and flags slow hooks; `/skill-doctor` reports skills worth turning off. Run them from the
  terminal for the harness's own numbers. [commands, skills]

## P — permissions

- **P1 Allowlist.** Repeated denials or asks on read-only commands → a narrow prefix
  (`Bash(cmd sub:*)`); `/doctor` offers to pre-approve frequently denied read-only commands.
  [best-practices, commands]
- **P2 Guardrails.** Destructive shapes go in `deny` or `ask`, or a PreToolUse hook — never
  prose alone. [features-overview]

## X — mirrors

- **X1 Shared lines.** A line changed in `$AP/claude/CLAUDE.md` changes in `~/.codex/AGENTS.md`
  and `$AP/cursor/USER_RULES.md` when they carry it; `~/claude/sync-agent-configs.fish` pushes
  CLAUDE.md and AGENTS.md to the mac-mini, so a local edit is not synced until it runs.
- **X2 Model-relative.** Codex and Cursor run other models; C10–C13 are Claude findings and do
  not transfer to the mirrors without their own evidence.
