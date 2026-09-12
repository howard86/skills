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

Accepts a bare session UUID (resolved against both corpora) or a file path. `--grep` keeps only matching messages, `--tail N` the last N, `--width` truncates each message (default 600 chars). `--last` prints only the final assistant text message (tool traffic excluded). Use it to pull a spawned subagent's closing report. `--last` and `--tail` are mutually exclusive. Start narrow: full sessions are large.

## prompts

```
bun $S prompts [--days N] [--project sub] [--grep re] [--width N] [--tail N] [--include-agents]
```

Chronological bulk dump of typed user prompts (no query), read straight from the Claude transcripts, the data source for the retro skill's pattern mining. The printed sess-id works with `show`. Defaults to `--days 30`; the scan cost scales with the window, so keep it as narrow as the question allows. Subagent transcripts are agent-authored spawn briefs, not typed prompts, so they are excluded by default (add `--include-agents` to include them). `--width` truncates each row (default 500 chars, `--width 0` = no truncation); `--grep` filters on the full text *before* truncation; `--tail N` keeps the last N rows. Messages starting with `<` (command wrappers, task notifications, teammate messages) are skipped; automation echoes (cron/loop firings) still appear and are filtered at analysis time.

A wide window easily exceeds context (`--days 30` runs ~240k tokens). Redirect to a file and grep it rather than paging the dump into context:

```
bun $S prompts --days 90 > /tmp/prompts.txt
grep -iE 'skill|retro' /tmp/prompts.txt | tail -50
```

## sessions

```
bun $S sessions [--source claude|codex|all] [--days N] [--project sub] [--limit N] [--include-agents]
```

Newest-first, one line per session: mtime, label, session id, first user prompt (truncated ~100 chars), path. Defaults to `--days 7`, `--limit 20`, subagent transcripts excluded (Claude `subagents/` files and Codex rollouts spawned by a parent thread; `--include-agents` to include them). Codex rows skip the injected AGENTS.md block and show the first typed prompt. Use it instead of hand-rolling `ls -t ~/.claude/projects/*/*.jsonl | head`, for example to find a just-spawned subagent's transcript, then `show <id> --last` for its closing report.

## Typical loop

1. `search --paths-only` (add `--days`) → note the session id.
2. `show <id> --grep <term>` → read the surrounding messages.
3. Need the exact command or error? add `--tools`.

Know it's recent but don't have a query? `sessions` lists it newest-first instead.

## Notes

- Requires `rg`, which prefilters a corpus of tens of GB (mostly Codex). `--days 0` takes several seconds warm and far longer cold, which is why `--days` defaults to 30.
- A query containing `"` or `\` disables the per-line parse prefilter (JSON escaping would cause misses); it still works, just slower.
- Codex `event_msg` records are skipped: they duplicate `response_item`.
- Codex sessions include large `developer`-role system prompts; they match often and rarely matter.
- `bun $S selfcheck` asserts the two parsers still match the on-disk formats. Run it if output looks empty or wrong.
