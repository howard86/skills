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
// Usage log: every ask() call, success or failure, appends one row (state, questions, answers,
// tokens, latency, caller) to a local SQLite file for later analysis of prompts and thresholds.
// Path: JEV_USAGE_DB, else $XDG_STATE_HOME/jev/usage.sqlite (default ~/.local/state). JEV_USAGE_DB=off
// disables it. Logging is fail-open: a locked or unwritable database never fails the call.
//
// CLI: `bun jev.ts models` lists the aliases the account can send;
//      `bun jev.ts ask < request.json` posts a raw {state, questions[, model, retries, caller, meta]} body and prints the answers;
//      `bun jev.ts usage [days]` summarises the usage log per caller (default 30 days).

import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

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

// --- usage log --------------------------------------------------------------
export const USAGE_DB =
  process.env.JEV_USAGE_DB ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "jev", "usage.sqlite");
let usageDb: Database | null | undefined;

function openUsage(): Database | null {
  if (usageDb !== undefined) return usageDb;
  if (USAGE_DB === "off") return (usageDb = null);
  try {
    mkdirSync(dirname(USAGE_DB), { recursive: true });
    const db = new Database(USAGE_DB, { create: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      caller TEXT NOT NULL,
      meta TEXT,
      model_requested TEXT NOT NULL,
      model TEXT,
      ok INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT,
      latency_ms INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      state TEXT NOT NULL,
      questions TEXT NOT NULL,
      answers TEXT
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS calls_caller_ts ON calls (caller, ts)");
    return (usageDb = db);
  } catch {
    return (usageDb = null);
  }
}

type UsageRow = {
  ts: string;
  caller: string;
  meta: string | null;
  model_requested: string;
  model: string | null;
  ok: number;
  http_status: number | null;
  error: string | null;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  state: string;
  questions: string;
  answers: string | null;
};

function recordUsage(row: UsageRow): void {
  try {
    openUsage()
      ?.query(
        `INSERT INTO calls (ts, caller, meta, model_requested, model, ok, http_status, error, latency_ms,
          input_tokens, output_tokens, state, questions, answers)
         VALUES ($ts, $caller, $meta, $model_requested, $model, $ok, $http_status, $error, $latency_ms,
          $input_tokens, $output_tokens, $state, $questions, $answers)`,
      )
      .run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])));
  } catch {
    /* logging never fails the call */
  }
}

// --- calls ------------------------------------------------------------------
// caller names the consumer in the usage log (default: the entry script's file name);
// meta is any JSON-able context worth keeping beside the call (session id, rule, item id).
type AskOptions = { model?: string; retries?: number; signal?: AbortSignal; caller?: string; meta?: unknown };

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
  const model = opts.model ?? DEFAULT_MODEL;
  const row = {
    ts: new Date().toISOString(),
    caller: opts.caller ?? basename(Bun.main),
    meta: opts.meta === undefined ? null : JSON.stringify(opts.meta),
    model_requested: model,
    state: typeof state === "string" ? state : JSON.stringify(state),
    questions: JSON.stringify(questions),
  };
  try {
    const json = (await post("/systemone", { state, model, questions }, opts)) as Omit<Response<Q>, "latency_ms">;
    const res = { ...json, latency_ms: Math.round(performance.now() - t0) };
    recordUsage({
      ...row,
      model: res.model ?? null,
      ok: 1,
      http_status: 200,
      error: null,
      latency_ms: res.latency_ms,
      input_tokens: res.usage?.input_tokens ?? null,
      output_tokens: res.usage?.output_tokens ?? null,
      answers: JSON.stringify(res.answers),
    });
    return res;
  } catch (e) {
    recordUsage({
      ...row,
      model: null,
      ok: 0,
      http_status: e instanceof JevError ? e.status : null,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      latency_ms: Math.round(performance.now() - t0),
      input_tokens: null,
      output_tokens: null,
      answers: null,
    });
    throw e;
  }
}

// Per-caller summary of the usage log over the last `days` days. Cost uses $0.042 per million input tokens.
export function usageSummary(days = 30) {
  const db = openUsage();
  if (!db) throw new Error(`usage log unavailable at ${USAGE_DB}`);
  return db
    .query(
      `SELECT caller, COUNT(*) AS calls, SUM(1 - ok) AS errors, CAST(AVG(latency_ms) AS INTEGER) AS avg_ms,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, MAX(ts) AS last
       FROM calls WHERE ts >= $since GROUP BY caller ORDER BY calls DESC`,
    )
    .all({ $since: new Date(Date.now() - days * 86_400_000).toISOString() }) as {
    caller: string;
    calls: number;
    errors: number;
    avg_ms: number;
    input_tokens: number;
    last: string;
  }[];
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
      const req = JSON.parse(await Bun.stdin.text()) as {
        state: Text;
        questions: Record<string, Question>;
        model?: string;
        retries?: number;
        caller?: string;
        meta?: unknown;
      };
      const r = await ask(req.state, req.questions, { model: req.model, retries: req.retries, caller: req.caller, meta: req.meta });
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === "usage") {
      const days = Number(process.argv[3] ?? 30);
      console.log(`${USAGE_DB} (last ${days} days)`);
      console.log("caller\tcalls\terrors\tavg_ms\tinput_tokens\tcost_usd\tlast");
      for (const r of usageSummary(days))
        console.log(
          `${r.caller}\t${r.calls}\t${r.errors}\t${r.avg_ms}\t${r.input_tokens}\t${((r.input_tokens * 0.042) / 1e6).toFixed(6)}\t${r.last}`,
        );
    } else {
      console.error("usage: bun jev.ts models | bun jev.ts ask < request.json | bun jev.ts usage [days]");
      process.exit(2);
    }
  } catch (e) {
    // One line, no stack: a 401 means the key is wrong, a 429 means the retries ran out.
    console.error(`jev: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
