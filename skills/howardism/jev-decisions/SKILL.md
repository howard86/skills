---
name: jev-decisions
description: Reference for making cheap, calibrated decisions over text with TypeSafe Jev (choice, score, yes/no with confidence), the shared helper other skills' scripts import, its local SQLite usage log, and where the API key lives.
disable-model-invocation: true
---

# Jev Decisions

Jev is TypeSafe's System One model. It takes a text `state` plus typed questions and returns structured answers with probabilities. It never generates text and never replaces the session model or a subagent's LLM. Calls take about 150 to 300 ms and cost $0.042 per million input tokens (output is free). Facts verified 2026-09-29 against docs.typesafe.ai.

## When to reach for it

Use Jev when the decision is a narrow judgment over text, there are many items, you want a confidence number, and code (not a model) owns the control flow. Examples: pick a model tier for a brief, label a transcript excerpt, check whether an issue spec is complete.

Ask the session model instead when the answer needs reasoning across files, open-ended writing, tools, or context beyond a text `state`. Jev is text only and English-best.

## Pick the primitive

- `choice`: one label from a criteria map (up to 255 options). Returns `choice`, `probabilities`, `confidence`.
- `score`: an ordered criteria array of 2 to 10 levels. Returns a probability-weighted `score`, `legend`, `probabilities`, `confidence`.
- `noul`: yes/no. Returns a 0..1 probability and no confidence. A value near 0.5 means "as likely yes as no", not medium intensity; treat the distance from 0.5 as the signal.

Questions in one request run in parallel over the same `state` and cannot see each other, so put independent questions in one call. Chain dependent ones in code.

To pick among labels, one `choice` beats one `noul` per label, even when an item can fit several. On the 2026-09-29 retro's 86 worker-verified skill-gap items, `choice` at confidence ≥ 0.8 was right 28 of 32 times. Per-skill `noul` put only 16 items at ≥ 0.8, still had 3 true matches below 0.2, and used 1.3× the tokens.

## State shape

Pass `state` as a JSON object with named fields (`brief`, `issue`, `excerpt`), not one blob. In each question's `instructions`, refer to nested fields in backticks (`issue.body`). Limits: 32k tokens for state plus the longest question, 64k total.

## Confidence bands

`band(confidence, {act: 0.8, confirm: 0.5})` returns `"act"` (proceed), `"confirm"` (proceed but flag or ask), or `"fallback"` (ignore the answer, use the pre-Jev behaviour). Thresholds scale with the cost of acting on a wrong answer: loosen them for a reversible label, tighten them for anything that spends money, merges, or deletes. Tune against real examples, then pin the model version: `jev-latest` moves (currently jev-1.13.0), and the response's `model` field reports which version answered.

## Using the helper from a script

`scripts/jev.ts` exports `ask(state, questions, {model?, retries?, caller?, meta?})` (retries 429 and 5xx, honours retry-after, returns typed answers plus `latency_ms`), `models()`, `band()`, and `apiKey()`.

Consumers today: the `jev-lens` Claude Code mod (through the `ask` CLI), subagent-routing `scripts/route.ts` (model tier from a brief), usage-retro `scripts/retro-scan.ts` (correction, nudge, wanted-skill labels), triage `scripts/triage-classify.ts` (category, state, spec completeness, out-of-scope match), afk-issue-loop `scripts/prescreen.ts` (migration, unmerged dependency, spec completeness).

A consumer resolves the helper by sibling path first, then the installed locations, and loads it dynamically:

```ts
import { resolve } from "node:path";
import { homedir } from "node:os";
const candidates = [
  resolve(import.meta.dir, "../../jev-decisions/scripts/jev.ts"),
  `${homedir()}/.claude/skills/jev-decisions/scripts/jev.ts`,
  `${homedir()}/.agents/skills/jev-decisions/scripts/jev.ts`,
];
```

Try each path with `await import(path)` and keep the first that loads. When none loads, or `apiKey()` throws, report `jev unavailable: <reason>` and run the pre-Jev behaviour. A missing key or network is never a failure of the consumer.

## Key storage

The key lives in the login Keychain, service `typesafe.ai`, account `jev`. Add it with `security add-generic-password -s typesafe.ai -a jev -U -w` and type the key at the prompt so it never enters shell history. `TYPESAFE_API_KEY` in the environment overrides it for CI or one-offs.

Keep the key out of fish config and Claude settings `env`: both reach every child process and can land in transcripts. The helper keeps it in a module local and never logs it; do not print headers or the client. The sandbox permits the `security` read.

Gotchas:
- The first read from a new binary can raise a Keychain ACL dialog. Choose Always Allow once, or unattended runs hang.
- A locked keychain (SSH, a LaunchAgent after reboot) fails with exit 36. Run `security unlock-keychain`.
- The rules engine's staged-secret-scan (gitleaks) gates commits, so a pasted key is caught before it lands.

## Usage log

Every `ask()` call, success or failure, appends one row to a local SQLite file (`bun:sqlite`): `$JEV_USAGE_DB`, else `$XDG_STATE_HOME/jev/usage.sqlite` (default `~/.local/state/jev/usage.sqlite`). `JEV_USAGE_DB=off` disables it. Table `calls` keeps `caller` (the entry script's file name unless `opts.caller` names it), `meta` (JSON from `opts.meta`), the requested and answering model, `ok`, `http_status`, `error`, `latency_ms`, token counts, and the full `state`, `questions`, and `answers` as JSON, so prompts and band thresholds can be tuned against real calls. Logging is fail-open and never fails the call.

The log holds whatever text consumers put in `state` (the rules engine's Stop gate stores the turn's final message), so treat the file as private. It is never pruned. Pass `opts.meta` for context worth joining on later, such as a session id or item id.

`bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts usage [days]` prints calls, errors, average latency, input tokens, and cost per caller. For anything deeper, query the file with `sqlite3`.

## Limits and errors

429 responses carry retry-after under fluctuating rate limits; the helper waits and retries. No streaming, no images.

## CLI and self-check

- `bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts models` lists the aliases the account can send.
- `bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts ask < request.json` posts a raw `{state, questions[, model, retries, caller, meta]}` body; `caller` and `meta` land in the usage log as they do for `ask()`.
- `bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts usage [days]` summarises the usage log per caller.
- `bun ${CLAUDE_SKILL_DIR}/scripts/probe.ts` lists models and routes one subagent brief through a four-question set. Run it after storing or rotating the key.
