#!/usr/bin/env bun
// Order and skip issues with TypeSafe Jev before the loop spends an agent run on them.
//
//   gh issue list --json number,title,body,labels | bun prescreen.ts
//   bun prescreen.ts --from-file issues.json
//
// stdout: the issue numbers to work, one per line: non-migration first, then migration-bearing
//         (GOTCHAS #2), ascending within each group.
// stderr: one line per skipped issue and per kept-but-flagged issue, with the reason.
// Skips only on an act-band answer: spec_completeness in the bottom level at confidence >= 0.8,
// or depends_on_unmerged >= 0.8 (GOTCHAS #6). A fallback-band answer keeps the issue.
// Exit: 0 ok, 1 bad input or a Jev request failed, 3 Jev unavailable (no helper or no key).
// On any non-zero exit stdout is empty, so the caller keeps its own order.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HELPER_CANDIDATES = [
  resolve(import.meta.dir, "../../jev-decisions/scripts/jev.ts"),
  join(homedir(), ".claude/skills/jev-decisions/scripts/jev.ts"),
  join(homedir(), ".agents/skills/jev-decisions/scripts/jev.ts"),
];

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

async function loadJev() {
  const path = HELPER_CANDIDATES.find((p) => existsSync(p));
  if (!path) fail(3, `jev unavailable: no jev.ts helper at ${HELPER_CANDIDATES.join(", ")}`);
  try {
    const jev = await import(path);
    await jev.apiKey();
    return jev as typeof import("../../jev-decisions/scripts/jev.ts");
  } catch (e) {
    fail(3, `jev unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Issue = { number: number; title: string; body?: string; labels?: { name: string }[] };

const argv = process.argv.slice(2);
const fromFile = argv[0] === "--from-file" ? argv[1] : undefined;
if (argv.length && !fromFile) fail(2, "usage: bun prescreen.ts [--from-file issues.json] < issues.json");

let issues: Issue[];
try {
  issues = JSON.parse(fromFile ? readFileSync(fromFile, "utf8") : await Bun.stdin.text());
  if (!Array.isArray(issues)) throw new Error("expected a JSON array of {number, title, body, labels}");
} catch (e) {
  fail(1, `prescreen: bad input: ${e instanceof Error ? e.message : String(e)}`);
}
if (!issues.length) process.exit(0);

const jev = await loadJev();
const key = await jev.apiKey();

const SPEC_LEVELS = [
  "Nothing actionable: a one-liner or vague wish with no concrete behaviour, scope, or reproduction",
  "Partially specified: the goal is clear but expected behaviour, scope, or reproduction steps are missing or ambiguous",
  "Fully specified: concrete expected behaviour and scope, with acceptance criteria or exact reproduction steps",
];
const QUESTIONS = {
  has_migration: {
    type: "noul" as const,
    instructions: "Does implementing `issue` involve database schema changes, a migration, or a data backfill?",
  },
  depends_on_unmerged: {
    type: "noul" as const,
    instructions:
      "Does `issue` say it needs scaffolding, a table, types, or another change that lives in a different PR " +
      "or issue that is not merged yet (for example 'blocked on #12' or 'after #12 lands')?",
  },
  spec_completeness: { type: "score" as const, instructions: "How completely does `issue` specify the work?", criteria: SPEC_LEVELS },
};

const state = (i: Issue) => ({
  issue: {
    number: i.number,
    title: i.title,
    labels: (i.labels ?? []).map((l) => l.name),
    body: i.body && i.body.length > 12000 ? `${i.body.slice(0, 12000)}\n[... trimmed]` : (i.body ?? ""),
  },
});

type Answers = Awaited<ReturnType<typeof jev.ask<typeof QUESTIONS>>>["answers"];
const answers = new Map<number, Answers>();
try {
  // Four requests in flight at a time; jev.ts retries 429s.
  const queue = [...issues];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let i = queue.shift(); i; i = queue.shift()) answers.set(i.number, (await jev.ask(state(i), QUESTIONS)).answers);
    }),
  );
} catch (e) {
  const msg = (e instanceof Error ? e.message : String(e)).split(key).join("<redacted>").split("\n")[0];
  fail(1, `prescreen: jev request failed: ${msg}`);
}

const topLevel = (p: Record<string, number>) => Number(Object.entries(p).sort((x, y) => y[1] - x[1])[0][0]);
const plain: number[] = [];
const migration: number[] = [];
for (const i of [...issues].sort((x, y) => x.number - y.number)) {
  const a = answers.get(i.number)!;
  const spec = a.spec_completeness;
  const specBand = jev.band(spec.confidence);
  const vague = topLevel(spec.probabilities) === 0;
  const dep = a.depends_on_unmerged.noul;
  const mig = a.has_migration.noul;
  const tag = `#${i.number} ${i.title}`;

  if (dep >= 0.8) {
    console.error(`prescreen: skip ${tag}: depends_on_unmerged ${dep.toFixed(2)} (foundation not on base yet, GOTCHAS #6)`);
    continue;
  }
  if (vague && specBand === "act") {
    console.error(`prescreen: skip ${tag}: spec_completeness bottom level at confidence ${spec.confidence.toFixed(2)} (nothing actionable)`);
    continue;
  }

  const flags: string[] = [];
  if (dep >= 0.5) flags.push(`depends_on_unmerged ${dep.toFixed(2)} (confirm band, check the blocker)`);
  if (vague) flags.push(`spec_completeness bottom level at confidence ${spec.confidence.toFixed(2)} (${specBand} band, too unsure to skip)`);
  else if (specBand !== "act") flags.push(`spec_completeness ${spec.score.toFixed(2)} at confidence ${spec.confidence.toFixed(2)} (${specBand} band)`);
  if (mig >= 0.5 && mig < 0.8) flags.push(`has_migration ${mig.toFixed(2)} (confirm band, ordered with migrations)`);
  if (flags.length) console.error(`prescreen: keep ${tag}: ${flags.join("; ")}`);

  (mig >= 0.5 ? migration : plain).push(i.number);
}

for (const n of [...plain, ...migration]) console.log(n);
