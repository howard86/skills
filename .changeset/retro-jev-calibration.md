---
"mattpocock-skills": patch
---

The `retro` scan's Jev use now calibrates itself. `retro-scan --briefs` also writes `items.jsonl` (one row per brief item with its Jev probability and the Jev model version, printed in the `jev:` header line), and a gap item Jev answers at 0.8 or above is settled instead of sent to a worker: it is listed under `settled by jev` in `scan.md`, and every 5th settled item stays in the brief tagged `(jev 0.93, audit)`. `--jev-act` moves the threshold and `--verify-all` disables settling. The new `retro-calibrate.ts` joins `items.jsonl` with the workers' verdicts, appends the labels to a private store under `$XDG_STATE_HOME/retro/`, and prints Jev's precision per band with the lowest threshold that meets a target.

Prompts of five words or fewer now reach Jev with the assistant's preceding reply as `previous_reply`, via the new opt-in `chatlog prompts --prev` flag, so context-free prompts like "babysit" are judged against what they refer to.
