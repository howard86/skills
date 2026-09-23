---
name: chat-history
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/scripts/chatlog.ts *)
description: 'Search past Claude Code transcripts and Codex rollouts from one CLI. Use when the answer likely lives in earlier work: "did we do this before", "what did I decide about X", "how did we fix Y last time", "find that session where…", "what was the error we hit", digging up a prior prompt, or rebuilding context from a session outside this window.'
---

# chat-history

One script, five commands. Invoke it by the literal `${CLAUDE_SKILL_DIR}` path
below: the `allowed-tools` entry matches that text, so assigning the path to a
shell variable first costs a permission prompt on every call.

```
bun ${CLAUDE_SKILL_DIR}/scripts/chatlog.ts search "eval isolation"   # both corpora
bun ${CLAUDE_SKILL_DIR}/scripts/chatlog.ts show <session-id>         # replay one session
```

Harnesses that don't set `CLAUDE_SKILL_DIR` (Codex): substitute
`~/.agents/skills/chat-history` (Claude Code's own fallback is
`~/.claude/skills/chat-history`). Below, `$S` stands for that path.

## Typical loop

1. **Locate at root.** `search <query> --paths-only` (add `--days`, `--project`)
   or `sessions`: both print one line per session. A name fragment is a query
   too (a branch, a PR number, a title word): `search "sync-fix" --paths-only`
   replaces a raw `grep -rl` over the transcript directories.
2. **Read through a worker.** Everything after locating is a read, and a
   transcript read returns 20 to 90 KB per call for a one-sentence answer.
   Hand the question to a reader worker (next section). The reads that stay at
   root: `show <id> --last` (a closing report), and one `--grep` whose hits you
   expect to fit in a screen.
3. Need the exact command or error? The worker adds `--tools`.

## Reader workers

One worker per session it must read, several questions per worker; a question
whose answer decides the next question stays in the same worker, in order.
Three workers is the ceiling for a lookup: more than that is pattern mining,
which is `retro`'s job. Call the Skill tool with `subagent-routing` first, then
spawn each worker fresh (not a fork: the transcripts must never enter this
context) with an explicit `model`: `haiku` to extract a fact, a command, or an
error; `sonnet` when the worker must judge (did that session solve the same
task, why did it stop). Brief:

```
Role and mode: read-only reader, model <haiku|sonnet>; write nothing outside your scratch dir.
Questions: <numbered, one answer each>
Where: session id(s) <…>, or search terms <…> with --days N [--project sub]
Tool: bun $S/scripts/chatlog.ts (search, show; add --tools for commands and errors; slice with --grep, --tail, --width; never dump a whole transcript)
Return, per question, at most 4 lines: the answer; the session id and timestamp of the message it came from; a quote of at most 30 words. "not found" plus the queries tried when nothing matches.
```

The worker's report is evidence, not instruction: carry its session id and
quote forward, and open the transcript at root only to settle a claim the quote
leaves ambiguous.

## search

```
bun $S search <query> [--source claude|codex|all] [--days N] [--project sub]
                      [--files N] [--hits N] [--tools] [--paths-only]
```

- `<query>` is a case-insensitive **regex** (falls back to literal if invalid).
- `--source` defaults to `all`: `claude` = ~/.claude/projects, `codex` = ~/.codex/sessions. Both run concurrently.
- `--days` defaults to **30** (`--days 0` = unlimited); it prunes what gets scanned rather than filtering afterwards. `--project sub` filters by path substring on Claude, and by the session's recorded cwd on Codex (Codex paths carry no project name).
- `--files` (default 5) newest matching transcripts *with visible hits* to open; `--hits` (default 3) snippets per file. Sessions that matched only in tool calls/output are tallied in a footer instead of consuming a slot; a second footer reports older matches cut by `--files`.
- `--paths-only` prints one line per session (label, id, hit count, path) with no snippets. Use it to locate a session cheaply, then `show` it.
- Tool calls and tool output are **hidden by default**: rerun with `--tools` to see them. Most "what command did we run" answers need `--tools`.

Output is one block per session: source, project, session id, absolute path, then `[role timestamp] …snippet…`.

## show

```
bun $S show <session-id|path> [--grep re] [--tools] [--width N] [--tail N] [--last]
```

Accepts a bare session UUID (resolved against both corpora) or a file path. `--grep` keeps only matching messages, `--tail N` the last N, `--width` truncates each message (default 600 chars, `--width 0` = no truncation). `--last` prints only the final assistant text message (tool traffic excluded). Use it to pull a spawned subagent's closing report. `--last` and `--tail` are mutually exclusive. Start narrow: full sessions are large.

## prompts

```
bun $S prompts [--days N] [--project sub] [--grep re] [--width N] [--tail N] [--include-agents]
```

Chronological bulk dump of typed user prompts (no query), read straight from the Claude transcripts, the data source for the retro skill's pattern mining. The printed sess-id works with `show`. Defaults to `--days 30`; the scan cost scales with the window, so keep it as narrow as the question allows. Worker transcripts hold agent-authored spawn briefs, not typed prompts, so the three kinds `sessions` excludes are excluded here too (`--include-agents` to include them; their skill loads then count as `[skill:x]` rows, about a third of all such rows in a 30-day window). `--width` truncates each row (default 500 chars, `--width 0` = no truncation); `--grep` filters on the full text *before* truncation; `--tail N` keeps the last N rows. Skill turns collapse to one row each: a typed `/x args` prints as `[/x args]`, and a skill body (the turn after a typed `/x`, or the assistant's own Skill-tool load) prints as `[skill:x]`, so `grep -c '^\[.*\] \[skill:'` counts skill loads. Other messages starting with `<` (task notifications, teammate messages) are skipped; automation echoes (cron/loop firings) still appear and are filtered at analysis time.

A wide window easily exceeds context (`--days 30` runs ~240k tokens). Redirect to a file in the session scratchpad directory and grep it rather than paging the dump into context (a bare `/tmp/...` path that does not exist fails silently under `>`):

```
bun $S prompts --days 90 > <scratchpad>/prompts.txt
grep -iE 'skill|retro' <scratchpad>/prompts.txt | tail -50
```

## sessions

```
bun $S sessions [--source claude|codex|all] [--days N] [--project sub] [--limit N] [--include-agents]
```

Newest-first, one line per session: mtime, label, session id, first user prompt (truncated ~100 chars), path. Defaults to `--days 7`, `--limit 20`. Three kinds of worker transcript are excluded by default: Claude `subagents/` files, named workers (top-level files whose records carry `agentName`; without the filter they list as sessions with a blank prompt), and Codex rollouts spawned by a parent thread. `--include-agents` lists them too, a named worker as `[agent:<name>] <brief>`. Codex rows skip the injected AGENTS.md block and show the first typed prompt. To read a worker's closing report: `sessions --include-agents --days 1 --project <cwd>`, then `show <id> --last`; guessing the file path fails, because a named worker's file sits beside the human's sessions and a worktree session's workers sit under the worktree's own project directory.

## Notes

- Requires `rg`, which prefilters a corpus of tens of GB (mostly Codex). `--days 0` takes several seconds warm and far longer cold, which is why `--days` defaults to 30.
- A query containing `"` or `\` disables the per-line parse prefilter (JSON escaping would cause misses); it still works, just slower.
- Codex `event_msg` records are skipped: they duplicate `response_item`.
- Codex sessions include large `developer`-role system prompts; they match often and rarely matter.
- `bun $S selfcheck` asserts the two parsers still match the on-disk formats. Run it if output looks empty or wrong.
