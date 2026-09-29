---
"mattpocock-skills": patch
---

`jev-decisions`: the shared `jev.ts` helper now logs every `ask()` call, success or failure, to a local SQLite file (`bun:sqlite`) at `$JEV_USAGE_DB`, else `${XDG_STATE_HOME:-~/.local/state}/jev/usage.sqlite`. Each row keeps the caller (the entry script's file name, or `opts.caller`), optional `opts.meta` JSON, the requested and answering model, status, error, latency, token counts, and the full state, questions, and answers, so prompts and confidence thresholds can be tuned against real calls. Every consumer (subagent-routing, retro, triage, afk-issue-loop, the rules engine's Stop gate) is covered without changes. Logging is fail-open, `JEV_USAGE_DB=off` disables it, and `bun jev.ts usage [days]` prints calls, errors, latency, tokens, and cost per caller.
