#!/usr/bin/env bun
// Recommend a starting model tier for a worker brief using TypeSafe's Jev classifier.
//
//   bun route.ts --brief-file brief.txt [--harness claude|codex|antigravity|cursor|grok] [--json]
//   bun route.ts < brief.txt
//
// One Jev request asks role, difficulty, risk, and brief completeness; the mapping to a tier
// below is plain code. Exit 3 with `jev unavailable: <reason>` on stderr when the helper or the
// key cannot be resolved or the call fails, so the caller falls back to the reference table.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HARNESSES = ["claude", "codex", "antigravity", "cursor", "grok"] as const;
type Harness = (typeof HARNESSES)[number];
type Tier = "cheap" | "standard" | "strong";

// Starting choices from each harness reference's "Suggested routing" table. The strong tier
// never names a usage-billed model: fable stays explicit-authorization only.
const MODELS: Record<Harness, Record<Tier, string> | null> = {
  claude: { cheap: "haiku", standard: "sonnet", strong: "opus" },
  codex: { cheap: "gpt-6-luna", standard: "gpt-6-sol", strong: "gpt-6-astra" },
  antigravity: { cheap: "flash", standard: "flash", strong: "pro" },
  cursor: { cheap: "grok-4.7-low", standard: "grok-4.7-medium", strong: "grok-4.7-high" },
  grok: null, // one model for every tier; the reference differentiates by agent type and mode
};
const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Google Antigravity",
  cursor: "Cursor CLI",
  grok: "Grok Build",
};
const MAX_BRIEF_CHARS = 8000; // Jev caps state at 32k tokens; stay well under.

const DIFFICULTY = ["mechanical", "ordinary", "demanding"] as const;
const RISK = ["none", "reversible", "irreversible"] as const;

const QUESTIONS = {
  role: {
    type: "choice",
    instructions: "Which worker role does `brief` describe?",
    criteria: {
      scout: "Tallies, fetches, greps, narrow extraction; read-only; the answer is a list or a number",
      implementer: "Edits code or docs, writes tests, groups commits; produces a diff",
      reviewer: "Judges a design, diagnoses a bug, or reviews a change for risk; produces a verdict",
    },
  },
  difficulty: {
    type: "score",
    instructions: "How much judgment does `brief` need from the worker?",
    criteria: [
      "Mechanical: the brief already says exactly what to look at and what to report, and the worker makes no decisions. " +
        "Examples: count files matching a pattern and list their names; grep for a symbol and report each location; " +
        "fetch one page and copy out a stated field; rename one identifier everywhere.",
      "Ordinary: the brief lays out a plan of several steps across a few files and the worker only makes small local choices while following it. " +
        "Examples: implement a described function and its unit tests; apply a specified edit to several docs; " +
        "group finished changes into commits by stated rules.",
      "Demanding: the worker has to work out what the right answer is, because the brief cannot. " +
        "Examples: diagnose why something fails without a known cause; choose between competing designs; " +
        "judge whether a change is safe to ship; review a design for flaws; fill in a plan the brief leaves open.",
    ],
  },
  risk: {
    type: "score",
    instructions: "What is the blast radius if the worker gets `brief` wrong?",
    criteria: [
      "None: read-only, nothing changes",
      "Reversible: local edits that a diff review catches",
      "Irreversible or external: pushes, merges, deletions, third-party side effects",
    ],
  },
  brief_complete: {
    type: "noul",
    instructions: "Does `brief` state the scope, the workspace, and what the worker must hand back?",
  },
} as const;

function unavailable(reason: string): never {
  console.error(`jev unavailable: ${reason}`);
  process.exit(3);
}

function usage(msg: string): never {
  console.error(`route: ${msg}\nusage: bun route.ts [--brief-file <path>] [--harness ${HARNESSES.join("|")}] [--json] (brief on stdin otherwise)`);
  process.exit(2);
}

// --- args --------------------------------------------------------------------
let briefFile: string | undefined;
let harness: Harness = "claude";
let asJson = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--brief-file") briefFile = argv[++i] ?? usage("--brief-file needs a path");
  else if (a === "--harness") {
    const h = argv[++i];
    if (!HARNESSES.includes(h as Harness)) usage(`unknown harness ${JSON.stringify(h)}`);
    harness = h as Harness;
  } else if (a === "--json") asJson = true;
  else usage(`unknown argument ${JSON.stringify(a)}`);
}

let brief: string;
if (briefFile) {
  const f = Bun.file(briefFile);
  if (!(await f.exists())) usage(`no such file ${briefFile}`);
  brief = await f.text();
} else {
  brief = await Bun.stdin.text();
}
brief = brief.trim();
if (!brief) usage("empty brief");
const truncated = brief.length > MAX_BRIEF_CHARS;
if (truncated) brief = brief.slice(0, MAX_BRIEF_CHARS);

// --- helper ------------------------------------------------------------------
const candidates = [
  resolve(import.meta.dir, "../../jev-decisions/scripts/jev.ts"),
  resolve(homedir(), ".claude/skills/jev-decisions/scripts/jev.ts"),
  resolve(homedir(), ".agents/skills/jev-decisions/scripts/jev.ts"),
];
const helperPath = candidates.find((p) => existsSync(p));
if (!helperPath) unavailable("jev-decisions helper not found (sibling skill, ~/.claude/skills, ~/.agents/skills)");
const jev = (await import(helperPath)) as typeof import("../../jev-decisions/scripts/jev.ts");

let key: string;
try {
  key = await jev.apiKey();
} catch (e) {
  unavailable(e instanceof Error ? e.message : String(e));
}

let r: Awaited<ReturnType<typeof jev.ask<typeof QUESTIONS>>>;
try {
  r = await jev.ask({ brief, harness: HARNESS_LABEL[harness] }, QUESTIONS as unknown as Parameters<typeof jev.ask>[1]) as typeof r;
} catch (e) {
  const msg = (e instanceof Error ? e.message : String(e)).split(key).join("<redacted>").replace(/\s+/g, " ");
  unavailable(msg);
}

// --- mapping -----------------------------------------------------------------
const { role, difficulty, risk, brief_complete } = r.answers;
const level = (score: number, n: number) => Math.min(n - 1, Math.max(0, Math.round(score)));
const diffLevel = DIFFICULTY[level(difficulty.score, DIFFICULTY.length)];
const riskLevel = RISK[level(risk.score, RISK.length)];
const bump: Record<Tier, Tier> = { cheap: "standard", standard: "strong", strong: "strong" };

const notes: string[] = [];
let tier: Tier | "unsure";
if (role.confidence < 0.5) {
  tier = "unsure";
  notes.push("use the harness default and say so");
} else {
  if (role.choice === "reviewer" || diffLevel === "demanding") tier = "strong";
  else if (role.choice === "scout") tier = "cheap";
  else tier = "standard";
  if (riskLevel === "irreversible") tier = bump[tier];
}
if (riskLevel === "irreversible") notes.push("needs an independent reviewer");
if (brief_complete.noul < 0.5) notes.push("improve the brief before raising effort");
if (tier !== "unsure" && jev.band(difficulty.confidence) === "fallback")
  notes.push("difficulty read is low-confidence; check the tier against the reference table");
if (truncated) notes.push(`brief truncated to ${MAX_BRIEF_CHARS} chars before classification`);

const ladder = MODELS[harness];
let model: string | null = null;
if (tier !== "unsure") {
  if (ladder) model = ladder[tier];
  else notes.push("map by the harness reference");
}

const out = {
  tier,
  model,
  harness,
  notes,
  answers: {
    role: { choice: role.choice, probabilities: role.probabilities, confidence: role.confidence, band: jev.band(role.confidence) },
    difficulty: {
      score: difficulty.score,
      level: diffLevel,
      probabilities: difficulty.probabilities,
      confidence: difficulty.confidence,
      band: jev.band(difficulty.confidence),
    },
    risk: { score: risk.score, level: riskLevel, probabilities: risk.probabilities, confidence: risk.confidence, band: jev.band(risk.confidence) },
    brief_complete: { noul: brief_complete.noul },
  },
  jev_model: r.model,
  latency_ms: r.latency_ms,
  input_tokens: r.usage.input_tokens,
};

if (!asJson) {
  const target = model ?? (tier === "unsure" ? "harness default" : "map by the harness reference");
  console.log(
    `tier ${tier} -> ${target} (${role.choice}, ${diffLevel} difficulty, ${riskLevel} risk; role conf ${role.confidence.toFixed(2)})` +
      (notes.length ? `; notes: ${notes.join("; ")}` : ""),
  );
}
console.log(JSON.stringify(out, null, 2));
