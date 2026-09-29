---
"mattpocock-skills": patch
---

Move six `in-progress/` skills to `deprecated/`: `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, and `writing-shape`. All are user-invoked and none has been typed once in the transcript corpus; the 2026-09-09 retro flagged them and the 2026-09-24 retro found the same. `claude-handoff` is covered by `subagent-routing` and the harness's resumable named agents; the others have no replacement and the `deprecated/README.md` says so per skill. Neither bucket is linked or shipped, so nothing changes for the plugin or the local skill directories.
