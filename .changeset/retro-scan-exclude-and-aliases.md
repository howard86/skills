---
"mattpocock-skills": patch
---

`retro-scan.ts` gains `--exclude <sid,...>` so the retro's own session stays out of the evidence tables (its prompts name the skills it audits), counts a marker for a skill's previous name as a load (`rebase-babysit`, the `-with-sonnet` pair), drops gap rows older than the skill's birth date (`SKILL_SINCE`), and treats an identical prompt of 80 or more characters repeated three times in one session as a loop echo (was 150). The retro skill passes the session id from the scratchpad path, documents the eligibility rules, and briefs the rules-engine worker with the linked-worktree route the auto-mode classifier allows.
