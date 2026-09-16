---
name: refresh-harness-references
description: Re-verify a multi-harness reference set against installed CLIs and vendor docs, then cut the claims the environment already answers.
disable-model-invocation: true
argument-hint: "[path to the reference set, e.g. skills/howardism/subagent-routing/references]"
---

# Refresh harness references

A reference set that describes several agent harnesses is a pile of dated claims about
software that ships weekly. Reading it tells you nothing: every sentence looks as true as
it did the day it was written. The defects are **drift** (the harness moved), **cache rot**
(the doc copies a lookup that has since changed), and **machine-state claims** (the doc
records what a config file said on a machine that has since been reset).

So the order is: check versions, pull both sources, then decide what the doc should have
been carrying in the first place. Prose comes last.

`/refine-skill` is the general one-skill version of this. Reach for this one when the target
is a *set* of parallel references, because steps 5 through 7 only exist across a set.

## 1. Version sweep

Before opening a single reference, get every harness's installed version and compare it
against whatever the files claim to have been checked against.

```
claude --version; codex --version; agy --version; cursor-agent --version; grok --version
```

This is the cheapest drift signal there is, and it is usually damning. On the 2026-09-16
run, all five harnesses had shipped since a review date eight days old, two of them by a
minor version. A file whose recorded version is behind is guilty until checked; a file whose
version matches still needs steps 2 and 3.

Done when every reference has a version verdict: behind, level, or recording no version at all.

## 2. Pull both sources, and prefer the installed one

Each harness has two sources of truth, and they disagree. Fetch the vendor's published doc,
then read what shipped onto this machine: a bundled guide (`~/.grok/docs/user-guide/`),
`--help` output, or the strings in the installed bundle.

**Installed beats published.** The published doc describes the current release; the installed
guide describes *your* release, and on the 2026-09-16 run it was the richer of the two. Grok's
bundled guide carried a whole roles-and-personas system that invalidated the reference's
central claim, and the reference already warned that the online guide and the installed docs
disagreed on capability arguments.

Then query the live catalogs, which cost seconds:

```
agy models; grok models; cursor-agent --list-models
```

Done when every reference has both a published and an installed source read, and every model
ID the file recommends has been confirmed present in a live catalog or marked as gone.

## 3. Test the machine-state claims

Any sentence describing what a config file contains, what a setting was set to, or what a
local check confirmed is the fastest-rotting line in the document. Open the actual file.

On the 2026-09-16 run, a reference carried a dated paragraph asserting a persisted parent
model selection and a configured Explore subagent model. The live `~/.cursor/cli-config.json`
had neither: both had reset to `default`. The paragraph had read as evidence for eight days.

Delete what is false. Do not replace it with a fresh dated claim about machine state, which
just restarts the clock. Keep the procedure for setting it; drop the assertion that it is set.

Done when every machine-state claim has been opened and confirmed, corrected, or deleted.

## 4. Sort each claim into cache or lookup

Now decide what the document should carry. Every claim is one of two things:

- A **lookup**: the environment answers it in one command. Model ID tables, available effort
  values, installed versions, whether a flag exists. A doc that copies these is a cache, and
  it earns its load only when the lookup is expensive. These are not expensive.
- **Knowledge**: what no command will tell you. Which ID is a trap, resolution and precedence
  order, what a worktree branches *from*, which setting silently wins over which, the reason
  behind a choice.

Cut the caches and name the command that regenerates them. Keep the knowledge, and keep the
role tiers, which are judgement rather than lookup. The tables that went stale in eight days
were all caches of a catalog command.

Done when every remaining table and list is knowledge, or is a cache you can defend as
expensive to look up.

## 5. Sweep the set for duplication

Read the harness files side by side and find the sentences that appear in all of them. A fact
restated in five files is one fact wearing five costumes: it costs five times the tokens, five
times the maintenance, and reads as five times more important than it is.

State it once in the shared contract, delete the restatements, and leave behind only each
harness's genuine deviation from it. Expect the harness files to get visibly shorter. That is
the result, not a side effect.

Done when no instruction appears in more than one file except as a named deviation.

## 6. Turn prohibitions into enforcement fields

Hunt every sentence that steers by prohibition (a reviewer that must not edit, a worker that
must not commit) and check whether the harness now has a field that enforces it. Harnesses
grow these steadily, and a rule the config enforces beats a rule the model must remember.

Replace the prohibition with the positive instruction plus the per-harness field. On the
2026-09-16 run, all five harnesses had grown a read-only mechanism since the references were
written, and not one of them was named.

Done when every prohibition is either backed by a named field per harness, or recorded as a
guardrail no harness can enforce.

## 7. Replace the date header with its regenerating command

A `Reviewed <date> against <version>` header asks the reader to trust a date. Replace it with
the command that reproduces the file's facts, so the next reader re-derives instead. Record
the last-checked version as supporting evidence if you like, but the document must not depend
on the date being fresh to be trustworthy.

This is the step that stops the whole process from being a recurring chore, so do not skip it
because the factual fixes felt like the real work.

Done when every reference opens with a command a reader can run, and steps 5 through 7 are
applied, which are the three that make the next refresh smaller than this one.

## Delegating the rewrite

The research is the expensive part and it does not delegate well: you finish it holding facts
no worker can re-derive cheaply. The rewrite does delegate, as one writer over the whole set,
given a brief that carries every verified fact explicitly.

Call the Skill tool with "implement-with-subagent". Two things that brief must say: forbid the
worker from re-researching (it will produce a different and worse fact set), and forbid running
any skill-linking script, which from a worktree silently repoints installed symlinks at a
directory that is about to be deleted.
