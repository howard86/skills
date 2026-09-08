---
name: refine-skill
description: Refine an existing skill by testing it against the live harness and its usage history before editing any prose.
disable-model-invocation: true
---

# Refine a skill

Improving a skill by reading it is the trap. A rubric pass finds wording; the defects that
actually cost you are **drift** (the skill describing a harness that has since moved) and
**dead wiring**, where the skill cannot fire or its bundled parts no longer resolve. Neither is
visible in the prose. Both are cheap to find by looking at the environment and the usage history
first.

So the order is: ground it, run it, check its claims, and only then edit words.

## 1. Ground it

Before reading the skill, establish whether it can run and whether it ever has.

- **Reachability.** Check `skillOverrides` in `~/.claude/settings.json` and
  `.claude/settings.local.json` (project wins). `off` hides it from the model and the Skill
  tool refuses it (whether `/name` still fires is disputed upstream, so type it and see);
  `user-invocable-only` hides the description from the model but keeps `/name` and scheduled
  tasks; `name-only` lists it without a description.
- **Description budget.** Compare the description's length against `skillListingMaxDescChars`
  (default 1536, often set far lower). Anything past the cut is invisible, and the tail is
  usually where the trigger phrases and the "use X instead" routing live.
- **Bundled parts resolve.** Run any bundled script by the path the skill tells you to use, from
  a realistic cwd. Confirm every referenced agent, sibling file, and symlink exists: a symlink
  into a repo that has since moved dangles silently.
- **Usage history.** Call the Skill tool with "chat-history" and run its `search` with
  `--days 0 --paths-only` and the query `Base directory for this skill: [^ ]*<name>`, the
  banner Claude Code prints when a skill loads (the default 30-day window hides older
  invocations). Zero invocations is a fact to explain, not a verdict: switched off, never installed,
  and genuinely rare read identically from the prose and differently from the settings.

Done when you can say how many times it fired, and what would stop it firing today.

## 2. Run it

Exercise the skill on a real task and watch where it goes wrong. This is where the expensive
defects surface, and nothing else finds them.

Watch for the skill asking for something the harness will not do: a foreground call in a
harness that only backgrounds, a permission mode that is now ignored, a parameter that has been
deprecated into a no-op. An instruction the harness cannot honour is worse than a missing one:
it reads as a safeguard while protecting nothing.

Done when one real invocation has run end to end, or you have recorded exactly why it cannot.

## 3. Check its claims

Every mechanism the skill names is a claim with a date on it. Take the list (tool parameters,
agent names, frontmatter fields, file paths, model IDs, CLI flags) and confirm each against the
current docs or by executing it. Prefer executing: a claim you tested beats a claim you read.

Drift concentrates in the parts that were true when written. Expect to find that the fix you
were about to make was already made, differently, or that the thing you assumed was correct for
compatibility is the one that fails.

Done when every named mechanism has been exercised or checked, with the stale ones listed.

## 4. Then edit the prose

Now call the Skill tool with "writing-for-agents" and apply it: pointers,
information hierarchy, completion criteria, leading words, pruning.

Two cautions this ordering earns you:

- **Rubrics disagree; measurement decides.** Guidance to prune a description and guidance to make
  it pushy for triggering are both right in the abstract. The real character cap settles it.
- **A "no-op" is a hypothesis.** Whether a sentence changes behaviour is model-relative and is
  settled by running the document, not by argument. Cut on judgement if you like, but record it
  as a judgement.

## 5. Fix one at a time

Apply a single fix, then verify that fix's own symptom before starting the next. Reproduce the
failure and the repair side by side where you can: the old path erroring next to the new one
proves more than any amount of re-reading.

Keep each commit to one concern, and make its message describe all and only what its diff does.

Done when every applied fix has a check that would fail if the fix regressed, and the ones you
could not verify are named as unverified rather than reported as done.
