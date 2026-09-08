---
name: refine-harness
description: Prune, relocate, and sharpen the always-on harness config — global CLAUDE.md, rules-engine rules, hooks, auto-memory, skill listing, permissions, and the Codex/Cursor mirrors — against Anthropic's guidance and the last 30 days of evidence, with exact token costs, per-rule compliance rates, and headless ablation probes for contested cuts.
disable-model-invocation: true
argument-hint: "[claude-md|rules|hooks|memory|skills|permissions|mirrors …] [--days N]"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/scripts/inventory.ts *) Bash(bun ${CLAUDE_SKILL_DIR}/scripts/ablate.ts *)
---

# Refine the harness

The always-on config is a budget: every line of the global CLAUDE.md, every rule the engine
injects, every MEMORY.md index line, and every model-invoked skill description is paid on every
turn, in every session and subagent. The failure mode is **sediment** — layers that were true
when written and never removed, until Claude ignores half of them. This skill cores through the
sediment with evidence, not by re-reading prose.

Three measurements back every decision, cheapest first:

- **Cost ledger** — what the config costs per session and per month; exact per-request token
  figures from `ablate.ts measure`.
- **Compliance** — for each rule, did behaviour follow the injection? Deterministic predicates
  over the audit log and transcript timelines, computed every run.
- **Ablation** — for a contested CLAUDE.md line, headless A/B runs with the line present and
  absent, scored by a probe's deterministic check.

Sibling skills own the other directions: `/retro` mines prompts for config that is *missing*;
`/refine-skill <name>` fixes *one skill's body*. Findings of those shapes are handed off.

Arguments: surface names limit the scan (default: all seven); `--days N` sets the evidence
window (default 30 — the transcript corpus is pruned at ~30 days, so a wider window silently
truncates; say so beside every count).

## 1. Inventory

Run the bundled script once; it prints every surface's facts, the compliance table, the cost
ledger, and the deltas against the previous baseline, in one call:

```
bun ${CLAUDE_SKILL_DIR}/scripts/inventory.ts --days 30
```

It resolves the config repo from the `~/.claude/CLAUDE.md` symlink (`$AP`), reads the
rules-engine audit log, and scans transcripts (main and subagent) modified inside the window,
skipping eval and probe projects. Read the whole output before forming any opinion.

If `GUIDANCE.md` reports itself stale (its `checked:` date older than 30 days, or `claude
--version` past its `claude-code:` field), refresh it first: fetch each URL in its `sources:`,
diff the page against the checks, update the checks and both fields.

Done when the inventory ran clean (or its failure is recorded and the same numbers were gathered
by hand) and the guidance is current.

## 2. Evidence

Behaviour is the evidence; the prose is the hypothesis. For every item on every in-scope surface,
attach one of: **holds without it** (no-op), **fails despite it** (lost or ambiguous), **earns its
keep** (behaviour follows it and would not otherwise), or **no evidence in window**.

- **Rules** — start from the compliance table. A rate under 70% on five or more evaluations is
  a harden candidate; 100% on many is a keep; a rule whose predicate returned no evaluable
  fires needs its transcripts read
  (`bun ~/.claude/skills/chat-history/scripts/chatlog.ts show <sess> --grep <term> --tools`,
  the session ids are printed beside each rule — grep the *predicate's* terms, not `rule:<id>`:
  `show` renders only user/assistant entries and rule injections live in `attachment` rows). False positives in the deny/ask samples are
  sharpen candidates; zero fires with no deny value is a cut candidate. `edit-discipline`
  rows are history — that rule was retired into the CLAUDE.md line it duplicated.
- **CLAUDE.md lines** — the *corrections* section lists user prompts shaped like corrections.
  Open the ones that touch a line's topic and read what Claude did just before. A correction
  that restates an existing line means the line is lost or ambiguous; a question Claude asked
  that a line already answers means the same. A line whose behaviour holds in sessions where
  nothing reinforced it is a no-op candidate — step 5 settles contested ones.
- **Memory** — read counts per file come from the inventory. Over-cap indexes drop every entry
  past line 200 / 25 KB, so those projects lose memories silently. Compare each memory against
  the rules and CLAUDE.md for restatement, and against the repo's own CLAUDE.md.
- **Hooks** — target liveness (the script exists; what it prunes or reads still exists),
  timeouts, and any `engine-error` / `lock-timeout` rows.
- **Skills** — invocations per skill in the window, dangling or frozen entries, descriptions
  past the listing cap, overrides naming nothing.
- **Permissions** — `permission-denied` and repeated `tool-failure` details.
- **Mirrors** — shared lines that drifted between `$AP/claude/CLAUDE.md`, `~/.codex/AGENTS.md`
  and `$AP/cursor/USER_RULES.md`.

Delegate only read-only transcript mining, and only when the window is wide (Sonnet, one agent
per surface at most). Every config write happens in this session: the auto-mode classifier
denies subagent briefs that mention hooks, settings, or the sandbox.

Done when every in-scope item carries one of the four evidence labels, with the window stated.

## 3. Lint

Apply every check in [`GUIDANCE.md`](GUIDANCE.md) to every in-scope item — the general checks
(C-series) to any always-loaded line, then the surface series (R, H, M, S, P, X). Pick the
model-specific block by the model actually in use (`model` in settings, and the session's own
model when it differs); guidance measured on one model is a hypothesis on another. One check the
inventory cannot run: compare each CLAUDE.md line against the system prompt currently in context
— the harness already injects progress-update cadence, autonomous completion, and scope rules,
and a line restating them is duplication.

Done when each check has been applied to each item and every hit is recorded, including the
ones judged not worth acting on.

## 4. Decide a move

Every finding gets exactly one move:

- **keep** — earns its keep; record the evidence so the next run does not re-litigate it.
- **cut** — no-op, derivable, stale, duplicated, or dead wiring.
- **move** — right content, wrong tier: always-on line → rules-engine moment rule, skill, or
  path-scoped `.claude/rules` file; "must hold every time" → hook or `permissions.deny`/`ask`;
  rule-shaped memory → rule; repo fact → that repo's CLAUDE.md.
- **merge** — the same meaning in two places → one source of truth, the other a pointer or gone.
- **sharpen** — vague → verifiable; prohibition → positive target with the guardrail kept;
  regex → anchored, with an `unless`; the one line that keeps being skipped → the single
  emphasized line.
- **harden** — advisory text that fires and is ignored → `action: deny`/`ask`, a Stop gate, or a
  hook.

Rank by leverage: tokens saved per session × sessions per month, plus corrections avoided,
minus build cost. Record every finding and filter at the report, never during the scan.

Done when each finding has a move, a rank, and the evidence line that justifies it.

## 5. Ablate contested cuts

A CLAUDE.md cut whose no-op status rests on judgement gets a measurement before the report:

```
bun ${CLAUDE_SKILL_DIR}/scripts/ablate.ts probes
bun ${CLAUDE_SKILL_DIR}/scripts/ablate.ts run --line "<substring of the line>" --runs 3
```

Each probe runs arm A (line present) and arm B (line removed, or `--replace "<text>"` for a
sharpen) N times each in a fresh fixture repo, headless, on Sonnet by default (`--model opus`
to test the session model). The global CLAUDE.md is excluded and the arm's text is served as
the fixture's project file; skills, hooks, and the system prompt are identical across arms.
Sessions are not persisted and the engine's audit goes to a throwaway directory. When no probe
targets the line, write one in `probes/<name>.json` first: `line` (substring), `prompt`,
`files`, `allowedTools`, `maxTurns`, a `check` (`all`/`any` of `file-contains`, `file-lacks`,
`file-lines-max`, `output-matches`, `output-lacks`, `output-max-chars`, `changed-lines-max`,
`changed-files-only`, `new-files-max`) and a `metric` (`changed_lines`, `output_chars`,
`num_turns`, `new_files`, `file_lines`). A probe exercises the behaviour the line describes
under a task that tempts the opposite.

Reading the result: the same pass rate and metric in both arms is evidence of no effect *for
that probe at that sample size*; a difference is evidence the line works. Three runs per arm
cost about half a dollar per probe on Sonnet and a few minutes; a small effect can hide at that
N, so a "no difference" carries the N when reported.

`ablate.ts measure --variant <file>` prints the exact per-request token cost of the global
CLAUDE.md and of a proposed variant, from three one-turn calls. Use it for any CLAUDE.md move,
before and after. The variant arm is served as the fixture's project file, which carries a
wrapper the global arm does not: an unchanged CLAUDE.md measured 847 as a variant against 731
as global (2.1.263, sonnet), so subtract ~116 from a variant's figure before comparing.

Done when every contested cut carries an ablation line (arms, N, pass rates, metrics) or an
explicit "not ablated" with the reason.

## 6. Report and confirm

Present one table — surface, item, move, evidence, expected effect — ranked, with the keeps in a
short trailing list. When there are more than ten findings or the user asked for a record, write
the same table plus the ablation and measure results to `~/claude/harness-notes.md`, newest
run on top, before asking.

Then ask which moves to apply (multi-select). Config writes change every future session, so the
selection is the user's.

Done when the user has chosen, or has said to stop at the report.

## 7. Apply, one move per commit

Each surface has its own edit path and its own gate. A move is applied when its gate passes.

- **CLAUDE.md** — edit `$AP/claude/CLAUDE.md` (the symlink target; never replace the symlink).
  Gate: `ablate.ts measure --variant $AP/claude/CLAUDE.md` shows the intended token delta,
  line count at or below before, at most one emphasized line, `git -C $AP diff` reads as the
  one move. Port a changed shared line to `~/.codex/AGENTS.md` and `$AP/cursor/USER_RULES.md`
  when they carry it (Cursor is a paste into Settings — say so).
- **Rules** — add, edit, or delete `$AP/rules-engine/rules/<id>.md`; `$AP/README.md` documents
  every frontmatter key. Gate: a `corpus.json` case for any regex touched,
  `bun run selfcheck` green from the main checkout, and `bun $AP/rules-engine/engine.ts
  --explain '<a real detail from the audit log>'` showing FIRES/skip as intended. A new or
  changed rule also gets a predicate in `inventory.ts` so its compliance is measured from the
  next run on. Rule edits need no reload.
- **Hooks and permissions** — edit `$AP/claude/settings.json`. Gate: the file parses, every
  command path exists, and the settings watcher picked it up (`/hooks` if not). Every running
  session sees the change, so probes stay side-effect-free.
- **Memory** — edit or delete the topic file and its `MEMORY.md` line together; `[[links]]`
  to a deleted memory are retargeted. Gate: index ≤ 200 lines and ≤ 25 KB, no orphan index
  lines, frontmatter carries `name`, `description`, `metadata.type`. Delete one file per
  command — batched deletes trip the auto-mode classifier.
- **Skills** — `skillOverrides` in settings for visibility; `disable-model-invocation: true` in
  the skill for zero listing cost; relink dangling entries with the skills repo's
  `scripts/link-skills.sh` from the main checkout; plugin skills are pruned from the cache, never
  overridden. A description or body defect is `/refine-skill <name>`.
- **Commit** — `git -C $AP commit` per move, conventional-commit subject naming the move
  (`chore(claude): cut …`, `feat(rules): harden …`). The repo history is the config audit trail.

Done when every chosen move has its gate passing and its commit, and any move that could not
be verified is named as unverified rather than reported as done.

## 8. Baseline

Close by recording the numbers the next run compares against:

```
bun ${CLAUDE_SKILL_DIR}/scripts/inventory.ts --days 30 --baseline
```

That appends one JSON line (date, version, model, sessions, CLAUDE.md size, rule count, fires
and compliance per rule, memory index sizes, listing size, corrections) to
`~/claude/harness-baselines.jsonl`; the next inventory prints deltas against it, including any
compliance rate that moved by ten points or more. Add the `measure` figure and the keeps with
their evidence to `~/claude/harness-notes.md`. Then a one-line delta: what was cut, moved,
merged, sharpened, hardened, and what the next run should watch.

Done when the baseline line is appended and the delta line is the last thing said.
