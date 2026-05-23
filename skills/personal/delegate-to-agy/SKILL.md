---
name: delegate-to-agy
description: Hand a self-contained coding task to the local `agy` (Antigravity) CLI in non-interactive print mode and get the result back. Bundles a thin bash wrapper that scopes agy to a target directory via --add-dir, runs `agy -p` with auto-approved tools (or a read-only review mode), and returns agy's answer and exit code. Use when the user wants to delegate/offload a task to agy or Antigravity, run agy headlessly, drive agy non-interactively, get a second agent's (Gemini/Antigravity) take, or fan work out to another local agent to save this session's context budget.
---

# Delegate to agy (Antigravity CLI)

Offload a **self-contained** task to a separate local agent — `agy`, the Antigravity
CLI — through its non-interactive print mode, then fold the result back into your
work. agy runs in its own process with its own context window, model (Gemini), and
tools, so this is the move when you want to keep *this* session's context lean, get a
second model's take, or run several local agents in parallel.

Unlike `delegate-to-kiro` (which speaks ACP/JSON-RPC and needs a Python client),
`agy` already has a clean one-shot mode — so this skill is just a thin bash wrapper
around `agy -p`. Verified against `agy` 1.0.x.

## Prerequisites

- `agy` on PATH and logged in. There is no `whoami`; agy uses Gemini OAuth at
  `~/.gemini/oauth_creds.json`. If you're not logged in, run `agy` once interactively
  to authenticate. The wrapper checks both and fails fast.

## Quick start

```bash
S=skills/personal/delegate-to-agy/scripts/agy-delegate.sh

# Delegate a scoped change; agy edits files in --dir using its own tools.
"$S" --dir ./apps/api "Add a --json flag to scripts/foo.py; update its --help"

# Read-only second opinion (no auto-approve; review-only preamble injected).
"$S" --read --dir . "Review src/auth.ts for security issues"

# Pipe a long brief on stdin; bump the timeout for a big task.
cat task.md | "$S" --dir ../svc --timeout 3600s

# Follow up on the same agy conversation.
"$S" --dir . -c "Now also add a regression test"
```

Exit code is agy's own (`0` on a clean turn). Flags: `--dir` (required scope),
`--read`, `--timeout DUR`, `-c`/`--continue`, `--conversation ID`. See
`scripts/agy-delegate.sh --help`.

## ⚠️ The `--dir` / `--add-dir` gotcha

`agy -p` does **not** inherit your shell's working directory — with no `--add-dir`
its tools run in `~/.gemini/antigravity-cli` (agy's own runtime dir), so work lands
in the wrong place. `--dir` is therefore **required** and is passed through as
`--add-dir <abspath>`. This is agy's equivalent of kiro's `--cwd`.

## When to delegate (and when not to)

**Good fits** — self-contained and verifiable on its own:
- A scoped change in a sub-directory ("refactor this module; keep tests green").
- An independent investigation or review whose *conclusion* is all you need back.
- Parallel work: kick off several runs in different `--dir`s at once.
- Saving context: a noisy, file-heavy task you don't want to spend *this* window on.

**Poor fits** — keep these in your own session:
- Tight, iterative back-and-forth — this is one prompt per run (use `-c` for a
  follow-up, but a real conversation is faster in-process).
- Tasks where you must watch every step and intervene mid-stream.

## Workflow

1. **Write a crisp, self-contained brief.** agy does not share your context. State
   the goal, exact files/scope, constraints ("don't touch X", "keep tests green"),
   and what "done" looks like. A vague brief wastes a whole run.
2. **Scope `--dir` tightly** to the narrowest directory containing the work.
3. **Run the wrapper.** agy's reply prints to stdout; its step log goes to stderr.
4. **Verify before trusting.** `git diff` what agy changed, run the repo's
   lint/type/test gates, read its summary. Integrate or discard — don't blind-commit
   a delegated diff.

## Safety

In the default (write) mode the wrapper passes `--dangerously-skip-permissions`, so
**agy runs shell commands and edits files in `--dir` without prompting** — that's
what makes unattended delegation work.

- Only delegate into directories you're willing to let an agent change. Prefer a
  clean working tree so the delegated diff is reviewable in isolation.
- `--read` injects a "review only" preamble and omits the auto-approve flag. It is a
  **soft** guarantee: agy's `settings.json` may set `toolPermission: always-proceed`,
  so agy can still act. Always `git diff` afterward to confirm nothing changed.
- Transcripts persist under `~/.gemini/antigravity-cli/conversations/` (plus
  `history.jsonl`) — resumable with `-c`/`--conversation`, but also a record.
- The model is whatever agy's `settings.json` (`model`) selects; there is no
  per-invocation `--model` flag. Change it in agy's `/settings` if needed.
