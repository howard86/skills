---
name: agent-status
description: Audit every unit of running work a session owns — in-process subagents, background Bash tasks, agent-bridge sessions, remote runs — and give each a live/quiet/stale verdict with the action taken. Use when the user asks to "verify states", "check if any are stuck", says a run "seems stale" or "seems stuck", asks why something "takes this long", wants idle agents cleared, or says "resume all subagents".
---

# Agent status

Every unit of running work gets one **verdict**: **live** (output within the last 5 min), **quiet** (silent 5–30 min and its process still exists), or **stale** (silent over 30 min, or its process gone without a terminal result). The audit is done when every unit has a verdict row and every stale unit has been acted on.

## Where running work lives

The project slug and session id come from the scratchpad path, `/private/tmp/claude-501/<project>/<session-id>/scratchpad`; every location below hangs off those two.

| Kind | Source of truth | Last-activity signal |
|---|---|---|
| In-process subagents, teammates, other local or cloud sessions | `ListAgents` tool | its status column, plus the transcript mtime below |
| Subagent transcripts | `~/.claude/projects/<project>/<session-id>/subagents/agent-*.jsonl` | file mtime; the last line is the last tool_use or text |
| Background Bash tasks | `/private/tmp/claude-501/<project>/<session-id>/tasks/<task-id>.output` (what `TaskOutput` reads) | file mtime; tail for a terminal marker |
| Processes those tasks launched | `ps -o pid,etime,command -p $(pgrep -d, -f 'cargo\|bun\|ssh\|python3')` | etime; presence |
| Agent-bridge sessions (Codex and other CLIs) | `mcp__agent-bridge__ListAgent`, then `AgentOutput` per id | output tail; `AgentUsage` for token burn |
| Remote runs (company-ng and similar) | `ssh -o BatchMode=yes <host> 'pgrep -af <bin>; ls -l --time-style=+%H:%M <log>'` | log mtime on the host |

`~/.claude/tasks/session-*/` is the todo list, not task output; it says nothing about liveness.

## Steps

1. **Enumerate.** Call `ListAgents`, list the subagents dir and the tasks dir, run the `ps` line, and `ListAgent` on agent-bridge when it was used this session. → *done when every unit has a kind, an id, and a last-activity timestamp; a source that errors is recorded as "unreachable", never dropped.*
2. **Judge.** Assign the verdict from the timestamps. A subagent whose last transcript line is a `tool_use` with no result after it has a hung tool: stale regardless of age. A background task whose process is gone with no terminal marker in its output (`Done:`, `exit=`, a closing summary) is stale.
3. **Act on stale.** Subagent: `TaskStop` (agent-bridge: `StopAgent`), then re-dispatch the remaining scope in a fresh brief that states what already landed. Background task: rerun with `run_in_background: true` as a loop that exits on the terminal condition. Remote run: kill by pid on the host, relaunch under `nohup` with a log. → *done when no stale row is without an action.*
4. **Wait on quiet, once.** A quiet run that is legitimately long (a sweep, a benchmark, image generation) gets one blocking wait — `Monitor` with `persistent: true`, or an `until` loop under `run_in_background` — and the session yields until the notification arrives. Re-checking it by hand is the loop this skill ends.
5. **Report.** One table: id | kind | last output | verdict | action. Finished-and-idle subagents are already released and need no clearing; only stale and quiet rows carry an action.
