---
name: jev-decisions
description: Reference for making cheap, calibrated decisions over text with TypeSafe Jev (choice, score, yes/no with confidence), the shared helper other skills' scripts import, and where the API key lives.
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

## State shape

Pass `state` as a JSON object with named fields (`brief`, `issue`, `excerpt`), not one blob. In each question's `instructions`, refer to nested fields in backticks (`issue.body`). Limits: 32k tokens for state plus the longest question, 64k total.

## Confidence bands

`band(confidence, {act: 0.8, confirm: 0.5})` returns `"act"` (proceed), `"confirm"` (proceed but flag or ask), or `"fallback"` (ignore the answer, use the pre-Jev behaviour). Thresholds scale with the cost of acting on a wrong answer: loosen them for a reversible label, tighten them for anything that spends money, merges, or deletes. Tune against real examples, then pin the model version: `jev-latest` moves (currently jev-1.13.0), and the response's `model` field reports which version answered.

## Using the helper from a script

`scripts/jev.ts` exports `ask(state, questions, {model?, retries?})` (retries 429 and 5xx, honours retry-after, returns typed answers plus `latency_ms`), `models()`, `band()`, and `apiKey()`.

Consumers today: subagent-routing `scripts/route.ts` (model tier from a brief), retro `scripts/retro-scan.ts` (correction, nudge, wanted-skill labels), triage `scripts/triage-classify.ts` (category, state, spec completeness, out-of-scope match), afk-issue-loop `scripts/prescreen.ts` (migration, unmerged dependency, spec completeness).

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

## Limits and errors

429 responses carry retry-after under fluctuating rate limits; the helper waits and retries. No streaming, no images.

## CLI and self-check

- `bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts models` lists the aliases the account can send.
- `bun ${CLAUDE_SKILL_DIR}/scripts/jev.ts ask < request.json` posts a raw `{state, questions[, model]}` body.
- `bun ${CLAUDE_SKILL_DIR}/scripts/probe.ts` lists models and routes one subagent brief through a four-question set. Run it after storing or rotating the key.
