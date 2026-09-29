// Thin client for the TypeSafe System One API (Jev). Bun only: uses Bun.$ for the Keychain read.
//
//   import { ask, band } from "./jev.ts";
//   const r = await ask({ brief }, { role: { type: "choice", instructions: "...", criteria: { a: "...", b: "..." } } });
//   r.answers.role.choice, r.answers.role.confidence, band(r.answers.role.confidence)
//
// Key resolution: TYPESAFE_API_KEY in the env (CI, one-off override), else the login Keychain item
// added with `security add-generic-password -s typesafe.ai -a jev -U -w`. The key lives in a module
// local and is never logged; do not print request headers or the client object.
//
// CLI: `bun jev.ts models` lists the aliases the account can send;
//      `bun jev.ts ask < request.json` posts a raw {state, questions[, model]} body and prints the answers.

import { $ } from "bun";

export const BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const KEYCHAIN = { service: "typesafe.ai", account: "jev" };

// --- key --------------------------------------------------------------------
let cachedKey: string | undefined;

export async function apiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  const r = await $`security find-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -w`.quiet().nothrow();
  const key = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  if (!key) {
    throw new Error(
      `no TYPESAFE_API_KEY in env and no Keychain item ${KEYCHAIN.service}/${KEYCHAIN.account} ` +
        `(exit ${r.exitCode}${r.exitCode === 36 ? ", keychain locked: run security unlock-keychain" : ""}); ` +
        `add one with: security add-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -U -w`,
    );
  }
  return (cachedKey = key);
}

// --- types (mirrors docs.typesafe.ai/api) ------------------------------------
export type Text = string | object | unknown[];
export type Choice = { type: "choice"; instructions: Text; criteria: Record<string, Text | null> };
export type Score = { type: "score"; instructions: Text; criteria: Text[] };
export type Noul = { type: "noul"; instructions: Text; criteria?: { true?: Text; false?: Text } };
export type Question = Choice | Score | Noul;

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type AnswerFor<Q extends Question> = Q extends Choice ? ChoiceAnswer : Q extends Score ? ScoreAnswer : NoulAnswer;

export type Response<Q extends Record<string, Question>> = {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
};

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

// --- calls ------------------------------------------------------------------
type AskOptions = { model?: string; retries?: number; signal?: AbortSignal };

// Retries 429 and 5xx, honouring retry-after (seconds or HTTP date) like the official SDKs do.
async function post(path: string, body: unknown, opts: AskOptions = {}): Promise<unknown> {
  const key = await apiKey();
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new JevError(`POST ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, text);
    const ra = res.headers.get("retry-after");
    const raMs = ra ? (Number.isNaN(Number(ra)) ? Date.parse(ra) - Date.now() : Number(ra) * 1000) : NaN;
    const waitMs = Number.isFinite(raMs) && raMs > 0 ? raMs : 500 * 2 ** attempt;
    await Bun.sleep(Math.min(waitMs, 30_000));
    attempt += 1;
  }
}

export async function ask<Q extends Record<string, Question>>(state: Text, questions: Q, opts: AskOptions = {}): Promise<Response<Q>> {
  const t0 = performance.now();
  const json = (await post("/systemone", { state, model: opts.model ?? DEFAULT_MODEL, questions }, opts)) as Omit<Response<Q>, "latency_ms">;
  return { ...json, latency_ms: Math.round(performance.now() - t0) };
}

export async function models(): Promise<{ name: string; description: string; release_date: string }[]> {
  const key = await apiKey();
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new JevError(`GET /models -> ${res.status}`, res.status, await res.text());
  return ((await res.json()) as { models: { name: string; description: string; release_date: string }[] }).models;
}

// --- confidence bands (docs.typesafe.ai/confidence, "three paths") ----------
// act: proceed automatically; confirm: proceed but flag or ask; fallback: do not act on the answer.
export type Band = "act" | "confirm" | "fallback";
export function band(confidence: number, thresholds: { act: number; confirm: number } = { act: 0.8, confirm: 0.5 }): Band {
  if (confidence >= thresholds.act) return "act";
  if (confidence >= thresholds.confirm) return "confirm";
  return "fallback";
}

// --- CLI --------------------------------------------------------------------
if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === "models") {
      for (const m of await models()) console.log(`${m.name}\t${m.release_date}\t${m.description}`);
    } else if (cmd === "ask") {
      const req = JSON.parse(await Bun.stdin.text()) as { state: Text; questions: Record<string, Question>; model?: string };
      const r = await ask(req.state, req.questions, { model: req.model });
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.error("usage: bun jev.ts models | bun jev.ts ask < request.json");
      process.exit(2);
    }
  } catch (e) {
    // One line, no stack: a 401 means the key is wrong, a 429 means the retries ran out.
    console.error(`jev: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
