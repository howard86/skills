---
name: delegate-to-kiro
description: Hand a self-contained coding task to a local kiro-cli agent over ACP (Agent Client Protocol) and get the result back. Bundles a dependency-free Python ACP client that spawns `kiro-cli acp`, runs the JSON-RPC handshake, opens a session in a target directory, sends one prompt, streams Kiro's tool calls, and returns its final answer. Use when the user wants to delegate/offload a task to kiro-cli, run Kiro headlessly, drive Kiro over ACP, get a second agent's take, or fan work out to another local agent to save this session's context budget.
---

# Delegate to kiro-cli (over ACP)

Offload a **self-contained** task to a separate local agent — kiro-cli — over the
Agent Client Protocol, then fold its result back into your work. Kiro runs in its
own process with its own context window and its own tools, so this is the move when
you want to keep *this* session's context lean, get a second model's take, or run
several local agents in parallel.

The protocol is verified against `kiro-cli` Agent 2.4.1. See [REFERENCE.md](REFERENCE.md)
for the exact wire format and troubleshooting.

## Prerequisites

- `kiro-cli` on PATH and logged in — check with `kiro-cli whoami` (must show an
  identity, not a login prompt).
- `python3` (stdlib only; no packages to install).

## Quick start

```bash
S=skills/personal/delegate-to-kiro/scripts/kiro-acp.py   # path to the client

# Stream Kiro's reply live; it edits files in --cwd using its own tools.
python3 "$S" --cwd ./apps/api "Add a --json flag to scripts/foo.py; update --help"

# Read-only second opinion (Kiro can still read files, but tell it not to write).
python3 "$S" --cwd . "Review src/auth.ts for security issues. Do not edit anything."

# Pipe a long brief on stdin; capture a structured result for programmatic use.
cat task.md | python3 "$S" --cwd ../svc --json --timeout 3600 > result.json
```

Exit code is `0` only when the turn ends cleanly (`stopReason: end_turn`);
`3` means none of the preferred models were available (it dropped out).
Useful flags: `--cwd` (where Kiro works), `--agent NAME`, `--model ID`,
`--resume SESSION_ID` (continue a prior Kiro session), `--no-trust`,
`--trust-tools "a,b"`, `--quiet`, `--verbose`, `--json`.

**Model selection.** With no `--model`, the client forces the best available of
`claude-opus-4.7` then `claude-opus-4.6`, and drops out (exit `3`) if neither is
offered — it never silently falls back to kiro's task-routed `auto`. Pass an
explicit `--model ID` (e.g. `--model auto`) to override.

## When to delegate (and when not to)

**Good fits** — the task is self-contained and verifiable on its own:
- A scoped change in a sub-directory ("refactor this module; keep tests green").
- An independent investigation or review whose *conclusion* is all you need back.
- Parallel work: kick off several `kiro-acp.py` runs in different `--cwd`s at once.
- Saving context: a noisy, file-heavy task you don't want to spend *this* window on.

**Poor fits** — keep these in your own session:
- Anything needing tight, iterative back-and-forth — ACP here is one prompt per run
  (use `--resume` for a follow-up, but a real conversation is faster in-process).
- Tasks where you must watch every step and intervene mid-stream.

## Workflow

1. **Write a crisp, self-contained brief.** Kiro does not share your context. State
   the goal, the exact files/scope, constraints (e.g. "don't touch X", "keep tests
   green"), and what "done" looks like. A vague brief wastes a whole run.
2. **Scope `--cwd` tightly.** Point Kiro at the narrowest directory that contains the
   work. It operates relative to that root.
3. **Run the client.** Tool calls stream to stderr; the reply streams to stdout (or
   use `--json` to capture `{sessionId, stopReason, text, metadata}`).
4. **Verify before trusting.** Treat the output like any agent's: `git diff` what
   Kiro changed, run the repo's lint/type/test gates, read its summary. Integrate or
   discard — don't blind-commit a delegated diff.

## Safety

By default the client passes `--trust-all-tools`, so **Kiro runs shell commands and
edits files in `--cwd` without prompting** — that is what makes unattended delegation
work. Consequences:

- Only delegate into directories you're willing to let an agent change. Prefer a repo
  with a clean working tree so the delegated diff is reviewable in isolation.
- For read-only work, say so in the prompt *and* pass `--no-trust` (Kiro will then ask
  per tool; the client auto-approves, so still review the diff) or restrict with
  `--trust-tools "fs_read"`.
- The session and full transcript persist under `~/.kiro/sessions/cli/` — resumable
  with `--resume`, but also a record to be aware of.
