#!/usr/bin/env bun
// Pre-screen an issue or PR with TypeSafe Jev and print a triage recommendation for step 2.
// It only reads: no label, comment, or state changes, ever.
//
//   bun triage-classify.ts 42                   # one issue or PR (gh issue view, falls back to gh pr view)
//   bun triage-classify.ts https://github.com/o/r/issues/42
//   bun triage-classify.ts --label needs-triage # every open issue with the label, one line each, most urgent first
//   bun triage-classify.ts --from-file issue.json   # a gh --json object, or an array of them (offline testing)
//
// Flags: --repo <owner/name> (passed to gh), --out-of-scope <dir> (default .out-of-scope in the cwd),
//        --json (raw Jev responses).
// Exit: 0 ok, 1 gh or Jev request failed, 2 usage, 3 Jev unavailable (no helper or no key).

import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// --- jev helper ---------------------------------------------------------------
const HELPER_CANDIDATES = [
  resolve(import.meta.dir, "../../../howardism/jev-decisions/scripts/jev.ts"),
  join(homedir(), ".claude/skills/jev-decisions/scripts/jev.ts"),
  join(homedir(), ".agents/skills/jev-decisions/scripts/jev.ts"),
];

async function loadJev() {
  const path = HELPER_CANDIDATES.find((p) => existsSync(p));
  if (!path) unavailable(`no jev.ts helper at ${HELPER_CANDIDATES.join(", ")}`);
  try {
    const jev = await import(path!);
    await jev.apiKey();
    return jev as typeof import("../../../howardism/jev-decisions/scripts/jev.ts");
  } catch (e) {
    unavailable(e instanceof Error ? e.message : String(e));
  }
}

function unavailable(reason: string): never {
  console.error(`jev unavailable: ${reason}`);
  process.exit(3);
}

// --- args ---------------------------------------------------------------------
type Args = { target?: string; label?: string; fromFile?: string; repo?: string; outOfScope: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { outOfScope: ".out-of-scope", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? usage(`${arg} needs a value`);
    if (arg === "--label") a.label = next();
    else if (arg === "--from-file") a.fromFile = next();
    else if (arg === "--repo") a.repo = next();
    else if (arg === "--out-of-scope") a.outOfScope = next();
    else if (arg === "--json") a.json = true;
    else if (arg.startsWith("-")) usage(`unknown flag ${arg}`);
    else a.target = arg;
  }
  if ([a.target, a.label, a.fromFile].filter(Boolean).length !== 1) usage("give exactly one of <number|url>, --label, --from-file");
  return a;
}

function usage(msg: string): never {
  console.error(`triage-classify: ${msg}`);
  console.error("usage: bun triage-classify.ts <number|url> | --label <name> | --from-file <json> [--repo o/r] [--out-of-scope dir] [--json]");
  process.exit(2);
}

// --- gather -------------------------------------------------------------------
type Issue = {
  number: number;
  title: string;
  body?: string;
  labels?: { name: string }[];
  author?: { login: string };
  url?: string;
  comments?: { author?: { login: string }; body: string }[];
};

const FIELDS = "number,title,body,labels,author,url,comments";

async function gh(args: string[]): Promise<string> {
  const r = await $`gh ${args}`.quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim().split("\n")[0] || `gh exited ${r.exitCode}`);
  return r.stdout.toString();
}

async function gather(a: Args): Promise<{ issues: Issue[]; list: boolean }> {
  const repo = a.repo ? ["--repo", a.repo] : [];
  if (a.fromFile) {
    const data = JSON.parse(readFileSync(a.fromFile, "utf8")) as Issue | Issue[];
    return Array.isArray(data) ? { issues: data, list: true } : { issues: [data], list: false };
  }
  if (a.label) {
    const out = await gh(["issue", "list", ...repo, "--state", "open", "--limit", "100", "--label", a.label, "--json", FIELDS]);
    return { issues: JSON.parse(out), list: true };
  }
  try {
    return { issues: [JSON.parse(await gh(["issue", "view", a.target!, ...repo, "--json", FIELDS]))], list: false };
  } catch (e) {
    // A PR number or /pull/ URL: gh issue view refuses it, gh pr view takes it.
    try {
      return { issues: [JSON.parse(await gh(["pr", "view", a.target!, ...repo, "--json", FIELDS]))], list: false };
    } catch {
      throw e;
    }
  }
}

// Keep state plus the longest question well under the 32k-token cap.
function trimmedState(i: Issue) {
  const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}\n[... trimmed]` : (s ?? ""));
  return {
    issue: {
      number: i.number,
      title: i.title,
      author: i.author?.login,
      labels: (i.labels ?? []).map((l) => l.name),
      body: clip(i.body, 8000),
      comments: (i.comments ?? []).slice(-10).map((c) => ({ author: c.author?.login, body: clip(c.body, 1200) })),
    },
  };
}

type Rejection = { key: string; file: string; text: string };

function loadRejections(dir: string): Rejection[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({
      key: `rejected_${basename(f, ".md").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      file: join(dir, f),
      text: readFileSync(join(dir, f), "utf8").slice(0, 1500),
    }));
}

// --- questions ----------------------------------------------------------------
const SPEC_LEVELS = [
  "Nothing actionable: a one-liner or vague wish with no concrete behaviour, scope, or reproduction",
  "Partially specified: the goal is clear but expected behaviour, scope, or reproduction steps are missing or ambiguous",
  "Fully specified: concrete expected behaviour and scope, with acceptance criteria or exact reproduction steps",
];
const URGENCY_LEVELS = [
  "Low: cosmetic, nice-to-have, or affects few users; can wait",
  "Normal: real but contained impact, or a workaround exists",
  "High: breaks core functionality, blocks users, loses data, is a security problem, or is a regression with no workaround",
];

function questions(rejections: Rejection[]) {
  const q: Record<string, any> = {
    category: {
      type: "choice",
      instructions: "Which triage category fits `issue`?",
      criteria: {
        bug: "Something is broken: behaviour differs from what the project intends or documents",
        enhancement: "A new feature, or an improvement to behaviour that currently works as designed",
        other: "Neither: a question, support request, discussion, duplicate notice, or spam",
      },
    },
    recommended_state: {
      type: "choice",
      instructions: "Which triage state should `issue` move to next?",
      criteria: {
        "needs-info": "Waiting on the reporter: reproduction steps, expected versus actual behaviour, or the request itself is missing or unclear",
        "ready-for-agent": "Fully specified and self-contained: an unattended agent could implement it from the issue alone, with no judgment calls, external access, design decisions, or manual testing",
        "ready-for-human": "Clear enough to act on, but needs a human: judgment calls, design decisions, external access, or manual testing",
        wontfix: "Will not be actioned: outside the project's scope, already implemented, or not a real problem",
      },
    },
    spec_completeness: { type: "score", instructions: "How completely does `issue` specify the work?", criteria: SPEC_LEVELS },
    urgency: { type: "score", instructions: "How urgent is `issue` for the project's users?", criteria: URGENCY_LEVELS },
  };
  for (const r of rejections) {
    q[r.key] = {
      type: "noul",
      instructions: {
        rejection: r.text,
        question:
          "Does `issue` request the concept that `rejection` records as rejected and out of scope? " +
          "Match by concept, not keyword: a request for the same capability under another name counts.",
      },
    };
  }
  return q;
}

// --- output -------------------------------------------------------------------
const topLevel = (p: Record<string, number>) => Number(Object.entries(p).sort((x, y) => y[1] - x[1])[0][0]);
const short = (s: string) => s.split(":")[0].toLowerCase();

type Result = { issue: Issue; res: any; rejections: Rejection[] };

function matches(r: Result) {
  return r.rejections.filter((x) => r.res.answers[x.key].noul >= 0.5).map((x) => ({ file: x.file, p: r.res.answers[x.key].noul as number }));
}

function printBlock(r: Result, band: (c: number) => string) {
  const a = r.res.answers;
  const row = (name: string, value: string, conf: number) =>
    console.log(`  ${name.padEnd(18)} ${value.padEnd(30)} conf ${conf.toFixed(2)}  ${band(conf)}`);
  console.log(`#${r.issue.number} ${r.issue.title}${r.issue.url ? `  ${r.issue.url}` : ""}`);
  row("category", a.category.choice, a.category.confidence);
  row("recommended_state", a.recommended_state.choice, a.recommended_state.confidence);
  const spec = topLevel(a.spec_completeness.probabilities);
  row("spec_completeness", `${a.spec_completeness.score.toFixed(2)} (${short(SPEC_LEVELS[spec])})`, a.spec_completeness.confidence);
  row("urgency", `${a.urgency.score.toFixed(2)} (${short(URGENCY_LEVELS[topLevel(a.urgency.probabilities)])})`, a.urgency.confidence);

  const fallbacks = ["category", "recommended_state", "spec_completeness", "urgency"].filter((k) => band(a[k].confidence) === "fallback");
  if (spec === 0) console.log("  needs-info signal: spec_completeness is in the bottom level");
  if (fallbacks.length) console.log(`  needs-info signal: fallback band on ${fallbacks.join(", ")}`);
  const m = matches(r);
  for (const x of m) console.log(`  prior-rejection match: ${x.file} (${x.p.toFixed(2)}); read it before recommending`);
  if (!r.rejections.length) console.log("  prior rejection: no .out-of-scope/*.md files checked");
  else if (!m.length) console.log(`  prior rejection: none of ${r.rejections.length} .out-of-scope file(s) matched`);
}

function printLine(r: Result, band: (c: number) => string) {
  const a = r.res.answers;
  const m = matches(r);
  console.log(
    [
      `#${r.issue.number}`,
      `urgency ${a.urgency.score.toFixed(2)}/${band(a.urgency.confidence)}`,
      `${a.category.choice}/${band(a.category.confidence)}`,
      `${a.recommended_state.choice}/${band(a.recommended_state.confidence)}`,
      `spec ${a.spec_completeness.score.toFixed(2)}/${band(a.spec_completeness.confidence)}`,
      r.issue.title,
      m.length ? `[prior rejection: ${m.map((x) => basename(x.file)).join(", ")}]` : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}

// --- main ---------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const jev = await loadJev();
const key = await jev.apiKey();
const redact = (s: string) => s.split(key).join("<redacted>");

let gathered: { issues: Issue[]; list: boolean };
try {
  gathered = await gather(args);
} catch (e) {
  console.error(`triage-classify: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (!gathered.issues.length) {
  console.error("triage-classify: no issues to classify");
  process.exit(0);
}

const rejections = loadRejections(args.outOfScope);
const qs = questions(rejections);
const results: Result[] = [];
try {
  // Four requests in flight at a time; jev.ts retries 429s.
  const queue = [...gathered.issues];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let i = queue.shift(); i; i = queue.shift()) results.push({ issue: i, res: await jev.ask(trimmedState(i), qs), rejections });
    }),
  );
} catch (e) {
  console.error(`triage-classify: jev request failed: ${redact(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  process.exit(1);
}

if (args.json) {
  const raw = results.map((r) => ({ number: r.issue.number, ...r.res }));
  console.log(JSON.stringify(gathered.list ? raw : raw[0], null, 2));
  process.exit(0);
}

console.log("Triage recommendation from Jev, input for step 2 (Recommend). It is never an automatic transition: nothing was labelled, commented, or closed.");
console.log("Bands: act >= 0.8, confirm >= 0.5, fallback below (do not lean on a fallback answer).\n");
if (gathered.list) {
  results.sort((x, y) => y.res.answers.urgency.score - x.res.answers.urgency.score || x.issue.number - y.issue.number);
  for (const r of results) printLine(r, jev.band);
} else {
  printBlock(results[0], jev.band);
}
