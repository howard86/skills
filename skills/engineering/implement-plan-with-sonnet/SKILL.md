---
name: implement-plan-with-sonnet
description: Hand the current implementation plan to a Sonnet subagent that implements it in an isolated git worktree and self-verifies the repo's gates, then re-check the diff and merge if green. Use when asked to implement a plan with Sonnet or a cheaper Claude model, or to save Opus cost — e.g. "implement this with Sonnet", "delegate the implementation to a cheaper model", "hand the plan to a smaller model". Requires an explicit model or cost signal; generic "execute the plan" routes to claude-mem:do instead.
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
- Trivial changes where worktree overhead isn't worth it.

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

### 2. Launch the subagent

Append to the brief:

> Implement everything above. Run the repo's gates. Iterate until all gates pass.
> Do not return until you can report them green — or list exactly what is red and why.

Then delegate:

```
Agent({
  subagent_type: "general-purpose",
  model: "sonnet",
  isolation: "worktree",
  mode: "acceptEdits",
  prompt: <self-contained brief with inlined plan>,
})
```

### 3. Re-check and merge

Prerequisite: the working tree should have been clean before you launched the subagent so that the
delegated diff is reviewable in isolation. When the subagent returns, examine the worktree it
created (path + branch in the result; if the subagent made no changes, the worktree is
auto-cleaned and nothing to merge).
Run `git diff HEAD..<branch>` to see what the subagent added, then re-run the repo's gates.
Merge if green; send back or discard if not. Never blind-merge a delegated diff.

## Fan-out (escape hatch)

If phases touch **disjoint** files/dirs, launch one subagent per phase in parallel, each in its
own worktree, and merge sequentially after all return. Use only when you can guarantee no
shared file writes.

## Limitations

- Reasoning effort cannot be set per-subagent via the `Agent` tool. Steer intensity through
  the brief wording instead (e.g. "think carefully before each step").
- The subagent does not share this session's context — the brief must be fully self-contained.
