---
name: implement-plan-with-sonnet
description: Hand a finished plan to a Sonnet subagent that builds it in an isolated worktree and self-verifies the repo's gates; re-check the diff and merge if green. Use on a bare "apply all" / "implement all" / "implement <plan>" past a handful of edits, on an explicit ask to delegate the build ("implement with subagents"), and on cost signals ("implement with Sonnet", "save Opus cost").
---

# Implement Plan with Sonnet

Offload the mechanical implementation of a finished plan to a cheaper Sonnet subagent —
Opus planned; Sonnet builds. The subagent runs in an isolated git worktree, self-verifies
the repo's gates, and returns a reviewable diff for the parent to merge.

## When to use

**Good fit** — the plan is finished and its correctness is verifiable:
- A scoped plan (from plan mode or a TaskList) where the implementation is mechanical.
- Cost-sensitive contexts: the reasoning was expensive; the coding is not.

**Poor fit** — keep in the current Opus session:
- Implementation requires Opus-level reasoning mid-stream (complex algorithms, subtle design calls).
- The plan tells the sub to re-baseline the very tests that would catch a regression: it rewrites
  its own oracle, so a green gate proves nothing. Keep that step in Opus; delegate the mechanical core.

## Background-job caveat — read first if you're a background job

The edit gate keys off **the job's** isolation, not the subagent's, so an isolated
`sonnet-implementer` spawned from a non-isolated job gets its Edit tool **blocked** and thrashes —
its own worktree does not satisfy the gate. Either:

- `EnterWorktree` in **this** (main) session first, then spawn a `model: sonnet` agent told to work
  **in that worktree in-place** rather than create its own, pausing any tree-cleanliness Stop hook
  so it doesn't race the sub on the shared tree.
- Or implement in the main session; anything design-heavy ends in an Opus takeover anyway.

In a **live interactive session** the pinned agent's own worktree isolation works — the happy path
below.

## Cwd caveat — the target repo is not the session cwd

`isolation: worktree` creates the worktree for the **session's cwd repo** and resolves the base
branch there: a detached-HEAD cwd, or a target repo nested elsewhere, fails with
`Failed to resolve base branch "HEAD"`. Make the worktree yourself and spawn into it in place:

```
git -C <repo> worktree add -b <branch> .claude/worktrees/<name> main
Agent({ subagent_type: "general-purpose", model: "sonnet",
        prompt: <brief> + "Work only under <absolute worktree path>; cd into it in every Bash
                command; leave committing to the parent." })
```

Keep sandbox and hook-config instructions out of the brief: the auto-mode classifier denies a
spawn whose brief mentions disabling the sandbox or editing `settings.json` hooks, and the
SubagentStart hook injects the worktree sandbox advice itself.

## Workflow

### 1. Get the plan

Prefer the durable plan-mode plan file (`~/.claude/plans/*.md`): **read and inline its full content**
into the brief — never pass a bare path (the subagent has separate context). If multiple plan files
exist, use the most recently modified one or ask. If no plan file exists, synthesize a brief from
the conversation or TaskList using this skeleton:

```
Goal:        <what gets built>
Scope:       <exact files/dirs to touch>
Constraints: <don't touch X, keep tests green, etc.>
Done:        <what "finished" looks like>
Gates:       <how to run the repo's verify commands — e.g. npm test>
```

**Keep long gates out of the subagent.** Name a *fast* check in `Gates` (a type-check or
`cargo check`, not the full suite) and run the real gates yourself after it returns. A sub told to
run a multi-minute suite can burn its budget inside the gate and return having stalled mid-build,
and you pay for the wasted run and re-launch it anyway. The parent has to re-run the gates on the
merged diff regardless (step 3), so gating inside the sub buys nothing
beyond catching its own typos early.

### 2. Launch the subagent

Delegate to the bundled `sonnet-implementer` agent (`agents/sonnet-implementer.md`).
It's pinned to Sonnet 5 at `effort: medium`, runs in its own worktree, and already carries the
minimal-diff discipline (smallest diff, no scope creep, commit-before-return), so the call site
doesn't repeat `model`/`effort`/`isolation` and the brief just hands it the plan:

> Implement the plan above; verify with the gates it names.

```
Agent({
  subagent_type: "sonnet-implementer",
  prompt: <self-contained brief with inlined plan>,
})
```

The subagent inherits this session's permission mode — the `mode` parameter is deprecated and
ignored, so passing it buys nothing. If the gate or `git` commands are blocked, allowlist them in the
project's `.claude/settings.json`, which scopes the grant to the commands the plan actually needs.
Use the prefixed `mattpocock-skills:sonnet-implementer` only where the plugin is installed; where the
agent comes from `~/.claude/agents`, the bare name is the one that resolves.

### 3. Re-check and merge

Prerequisite: the working tree should have been clean before you launched the subagent so that the
delegated diff is reviewable in isolation. When the subagent returns, examine the worktree it
created (path + branch in the result; if the subagent made no changes, the worktree is
auto-cleaned and nothing to merge).
Run `git diff HEAD..<branch>` to see what the subagent added, then re-run the repo's gates.
If any re-baselined tests slipped into the delegated plan, don't trust the green gate: diff every
changed expectation against its old value and sanity-check each delta yourself before merging.
Merge if green; send back or discard if not.

## Fan-out (escape hatch)

If phases touch **disjoint** files/dirs, launch one subagent per phase in parallel, each in its
own worktree, and merge sequentially after all return. Use only when you can guarantee no
shared file writes.

## Limitations

- Effort is fixed at `medium` in the agent definition; bump it there if a plan needs heavier reasoning.
- The subagent does not share this session's context — the brief must be fully self-contained.
