#!/usr/bin/env bun
// Self-check for jev.ts: lists models, then routes one scout-shaped subagent brief
// through the question set proposed for subagent-routing and prints answers, bands, cost.
import { ask, band, models } from "./jev.ts";

console.log("models:");
for (const m of await models()) console.log(`  ${m.name}\t${m.release_date}\t${m.description}`);

const brief =
  "Count how many SKILL.md files under skills/ carry `disable-model-invocation: true`, " +
  "list their names, and report the total. Read-only; do not edit anything.";

const r = await ask(
  { brief, harness: "Claude Code", workspace: "/Users/howard86/howardism/skills" },
  {
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
        "Mechanical: one command or a lookup answers it",
        "Ordinary: several steps, all spelled out, no ambiguity",
        "Demanding: the worker must resolve ambiguity or design something",
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
  },
);

console.log(`\nmodel ${r.model}, ${r.latency_ms} ms, ${r.usage.input_tokens} in / ${r.usage.output_tokens} out`);
const { role, difficulty, risk, brief_complete } = r.answers;
console.log(`role           ${role.choice}  conf ${role.confidence.toFixed(2)}  band ${band(role.confidence)}  ${JSON.stringify(role.probabilities)}`);
console.log(`difficulty     ${difficulty.score.toFixed(2)}  conf ${difficulty.confidence.toFixed(2)}  band ${band(difficulty.confidence)}  ${JSON.stringify(difficulty.probabilities)}`);
console.log(`risk           ${risk.score.toFixed(2)}  conf ${risk.confidence.toFixed(2)}  band ${band(risk.confidence)}  ${JSON.stringify(risk.probabilities)}`);
console.log(`brief_complete ${brief_complete.noul.toFixed(2)}`);
