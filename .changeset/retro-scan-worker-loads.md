---
"mattpocock-skills": patch
---

The `retro` scan's skill-usage table gains a `worker` column counting `[skill:x]` loads inside subagent transcripts, so skills loaded only by workers stop reading as unused. Worker rows feed only that column; every other section is unchanged. The `implement-with-subagent` keyword pattern drops the bare `implement`, and `commit-with-subagent` also matches `create commits`.

`chatlog prompts --include-agents` now marks agent rows with a fourth header token, `[ts project sid agent]`, and `retro-scan` reads it, so the scan runs chatlog once instead of twice and a saved `--prompts` dump yields worker counts when taken with `--include-agents`. Worker loads also feed a skill's `projects`, `first` and `last` cells. The scan's output strings no longer contain em-dashes, and the repo rule now covers string literals that print prose.
