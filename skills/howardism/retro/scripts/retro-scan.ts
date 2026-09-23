#!/usr/bin/env bun
// retro-scan: turn `chatlog prompts` output into the retro's evidence tables.
// Owns the noise filter (harness rows, skill markers, command bodies, goals) and every tally
// the retro reads: skill usage, corrections, nudges, repeats, long prompts, keyword→skill gaps.
//
//   bun retro-scan.ts [--days N] [--project sub] [--prompts file] [--cap N] [--selfcheck]
//
// `--prompts file` reuses a saved `chatlog prompts --width 0` dump instead of rescanning.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Row = { ts: string; project: string; sid: string; text: string };

// --- noise ------------------------------------------------------------------
// Harness rows the chatlog dump still carries. Prefix match on the first 200 chars.
const HARNESS_ROWS = [
  "[Image:", "[Request interrupted", "This session is being continued", "Stop hook feedback:",
  "## Context Usage", "The fork runs as its own", "<teammate-message", "<local-command",
  "[Cross-session idle notice]", "[Your previous response had no visible output",
  "Continue from where you left off.", "# Autonomous loop check", "<<autonomous-loop-dynamic>>",
  "Goal check-in:", "Skill /", "# /loop",
];
const HARNESS_ROW_RE = [/^Background agent ".*" was stopped by the user\.?$/s];
// Bodies of commands and always-loaded skills that land as user turns without a marker
// (built-ins, vault commands). Add a prefix here when a "repeat" turns out to be one.
const COMMAND_BODIES = [
  "# Claude Code Doctor", "# Fewer Permission Prompts", "Approach this as the design lead",
  "Compile new raw documents", "Audit the knowledge base", "Scout ingest-ready", "Ingest content from a URL",
  "Parse a local asset", "Distill actionable", "Answer a research question", "Close scoped alpha",
  "Operate a worker fleet", "Review recent sessions for workflow friction", "Produce `<new-cards>`",
  "Run one unattended research", "Show the current state of the knowledge base", "Scout fresh external sources",
  "Distill an alpha family", "# Update Config Skill",
];
const NUDGE_RE = /^\s*(continue|retry|resume|go on|proceed|yes|ok|y)\s*[.!]?\s*$/i;
// Wider than the rules engine's `pushback` anchor: it also catches the openers the ledger misses.
const CORRECTION_RE = /^\s*(no|nope|don'?t|dont|correction|actually|i mean|instead|revert|discard|prefer|turn off|wrong|stop|wait|undo|remove)\b/i;
// Prompts that name a skill's job without naming the skill. A hit counts as a gap when no
// marker for that skill appears in the same session.
const SKILL_KEYWORDS: Record<string, RegExp> = {
  "rebase-babysit": /\b(rebase|babysit|rescue (the|this) pr|watch ci|stale pr)\b/i,
  "commit-with-subagent": /\b(atomic commits?|create (a |another )?pr|open (a )?pr|draft pr|\bcommit)\b/i,
  "implement-with-subagent": /\b(implement|subagent|sub-agent|delegate)\b/i,
  "perf-": /\b(perf|performance|benchmark|bench|latency|hot ?path|faster|slow|alloc)\b/i,
  "chat-history": /\b(last time|did we|previous session|earlier session|what did (i|we)|chat-history)\b/i,
  "disk-cleanup": /\b(disk|free space|clean ?up large|stale worktrees)\b/i,
  "agent-status": /\b(stuck|stale|idle agents|still running|takes (this|so) long|verify states)\b/i,
  "research": /\bresearch\b/i,
  "writing-for-agents": /\b(skill|claude\.md|agents\.md|standing rule)\b/i,
  "resolving-merge-conflicts": /\bconflicts?\b/i,
};

// --- input ------------------------------------------------------------------
function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function findChatlog(): string {
  const candidates = [
    resolve(import.meta.dir, "../../chat-history/scripts/chatlog.ts"),
    join(homedir(), ".claude/skills/chat-history/scripts/chatlog.ts"),
    join(homedir(), ".agents/skills/chat-history/scripts/chatlog.ts"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`chatlog.ts not found; looked in ${candidates.join(", ")}`);
  return hit;
}

export function parsePrompts(dump: string): Row[] {
  const rows: Row[] = [];
  const head = /^\[(\S+) (\S+) (\S+)\] (.*)$/;
  for (const line of dump.split("\n")) {
    const m = head.exec(line);
    if (m) rows.push({ ts: m[1], project: m[2], sid: m[3], text: m[4] });
    else if (rows.length && line) rows[rows.length - 1].text += "\n" + line;
  }
  return rows;
}

// --- classify ---------------------------------------------------------------
type Kind = "typed-skill" | "loaded-skill" | "goal" | "harness" | "body" | "hand";
export function classify(text: string): Kind {
  if (/^\[\/[^\]]+\]$/.test(text)) return "typed-skill";
  if (/^\[skill:[^\]]+\]$/.test(text)) return "loaded-skill";
  if (text.startsWith("A session-scoped Stop hook")) return "goal";
  const headText = text.slice(0, 200);
  if (HARNESS_ROWS.some((n) => headText.includes(n)) || HARNESS_ROW_RE.some((r) => r.test(text))) return "harness";
  if (COMMAND_BODIES.some((n) => headText.includes(n)) || text.startsWith("Base directory for this skill:")) return "body";
  return "hand";
}

const skillOf = (text: string) => (/^\[\/([^\s\]]+)/.exec(text) ?? /^\[skill:([^\]]+)\]/.exec(text))?.[1] ?? "";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
const one = (s: string, n = 100) => s.replace(/\s+/g, " ").slice(0, n);
const short = (p: string) => p.slice(-30);

function counter<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}
const sorted = <T>(m: Map<T, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

// --- report -----------------------------------------------------------------
export function report(rows: Row[], days: number, cap: number, ledger: string): string {
  const out: string[] = [];
  const home = "-" + homedir().replace(/\//g, "-");
  // Harness projects: every session holds exactly one prompt (eval fixtures, cron).
  const perProject = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!perProject.has(r.project)) perProject.set(r.project, new Map());
    const s = perProject.get(r.project)!;
    s.set(r.sid, (s.get(r.sid) ?? 0) + 1);
  }
  const harnessProjects = new Set(
    [...perProject].filter(([p, s]) => p === home || p.startsWith("-private-tmp") || (s.size >= 3 && [...s.values()].every((v) => v === 1))).map(([p]) => p),
  );
  const kept = rows.filter((r) => !harnessProjects.has(r.project));
  const kinds = new Map<Kind, Row[]>();
  for (const r of kept) {
    const k = classify(r.text);
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k)!.push(r);
  }
  const hand = kinds.get("hand") ?? [];
  const typed = kinds.get("typed-skill") ?? [];
  const loaded = kinds.get("loaded-skill") ?? [];
  const sessionSkills = new Map<string, { ts: string; name: string }[]>();
  for (const r of [...typed, ...loaded]) {
    if (!sessionSkills.has(r.sid)) sessionSkills.set(r.sid, []);
    sessionSkills.get(r.sid)!.push({ ts: r.ts, name: skillOf(r.text) });
  }
  const loadedIn = (sid: string, prefix: string) => (sessionSkills.get(sid) ?? []).some((s) => s.name.startsWith(prefix));

  out.push(`# retro-scan: last ${days}d — ${rows.length} rows, ${hand.length} hand-typed`);
  out.push(`dropped: harness projects ${harnessProjects.size} (${[...harnessProjects].map(short).join(", ") || "none"}); harness rows ${(kinds.get("harness") ?? []).length}; command bodies ${(kinds.get("body") ?? []).length}`);

  // Ledger
  out.push("\n## Push-back ledger");
  const since = Date.now() - days * 86_400_000;
  const ledgerRows: any[] = [];
  let ledgerFirst = "";
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (!ledgerFirst) ledgerFirst = row.ts;
        if (String(row.rule ?? "").startsWith("pushback") && Date.parse(row.ts) >= since) ledgerRows.push(row);
      } catch {}
    }
  }
  if (!ledgerRows.length) out.push(`0 rows (ledger starts ${ledgerFirst || "n/a"}; pushback rules exist since 2026-09-18 — expected when no anchored correction was typed; the corrections section below is the fallback)`);
  for (const r of ledgerRows) out.push(`- ${r.ts.slice(0, 16)} ${r.rule} ${short(r.cwd ?? "")} ${String(r.session).slice(0, 8)} :: ${one(String(r.detail ?? ""))}`);

  // Skills
  out.push("\n## Skill usage (typed `/x` vs assistant-loaded)");
  const bySkill = new Map<string, { typed: number; loaded: number; projects: Set<string>; first: string; last: string }>();
  for (const r of [...typed, ...loaded]) {
    const n = skillOf(r.text);
    const e = bySkill.get(n) ?? { typed: 0, loaded: 0, projects: new Set(), first: r.ts, last: r.ts };
    if (classify(r.text) === "typed-skill") e.typed++; else e.loaded++;
    e.projects.add(r.project);
    if (r.ts < e.first) e.first = r.ts;
    if (r.ts > e.last) e.last = r.ts;
    bySkill.set(n, e);
  }
  out.push("| skill | typed | loaded | projects | first | last |\n|---|---|---|---|---|---|");
  for (const [n, e] of [...bySkill].sort((a, b) => b[1].typed + b[1].loaded - a[1].typed - a[1].loaded))
    out.push(`| ${n} | ${e.typed} | ${e.loaded} | ${e.projects.size} | ${e.first.slice(0, 10)} | ${e.last.slice(0, 10)} |`);
  const mentions = hand.filter((r) => /(?<![\w/`.~])\/[a-z][a-z0-9-]{2,}\b(?![/.-])/.test(r.text));
  out.push(`\nMid-sentence /skill mentions: ${mentions.length}`);
  for (const r of mentions.slice(0, cap)) {
    const names = [...r.text.matchAll(/(?<![\w/`.~])\/([a-z][a-z0-9-]{2,})\b(?![/.-])/g)].map((m) => m[1]);
    const after = new Set((sessionSkills.get(r.sid) ?? []).filter((s) => s.ts >= r.ts).map((s) => s.name));
    out.push(`- ${r.ts.slice(0, 16)} ${r.sid} ${names.join(",")} → loaded after: ${[...after].join(",") || "none (a command or hidden skill is read with cat and leaves no marker)"} :: ${one(r.text, 70)}`);
  }

  // Keyword → skill gaps
  out.push("\n## Keyword→skill gaps (prompt names the job, session never loaded the skill)");
  for (const [skill, re] of Object.entries(SKILL_KEYWORDS)) {
    const hits = hand.filter((r) => re.test(r.text));
    const gaps = hits.filter((r) => !loadedIn(r.sid, skill));
    if (!hits.length) continue;
    out.push(`- ${skill}: ${gaps.length} gap / ${hits.length} hit`);
    for (const r of gaps.slice(0, Math.min(cap, 6))) out.push(`    ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 90)}`);
  }

  // Corrections
  const corrections = hand.filter((r) => CORRECTION_RE.test(r.text));
  out.push(`\n## Correction openers: ${corrections.length}`);
  for (const r of corrections.slice(0, cap * 2)) out.push(`- ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 140)}`);

  // Nudges
  const nudges = hand.filter((r) => NUDGE_RE.test(r.text));
  out.push(`\n## Nudges: ${nudges.length} (verify the cause per session: \`chatlog show <sid> --grep "529|limit|Overloaded"\`)`);
  const nudgeBySid = counter(nudges.map((r) => `${short(r.project)} ${r.sid}`));
  for (const [k, v] of sorted(nudgeBySid).slice(0, cap)) out.push(`- ${v}× ${k}`);

  // Repeats
  out.push("\n## Repeated prompts");
  const exact = counter(hand.map((r) => norm(r.text).join(" ")).filter((s) => s.length > 2));
  for (const [k, v] of sorted(exact).filter(([, v]) => v >= 2).slice(0, cap)) out.push(`- ${v}× exact: ${one(k, 90)}`);
  const clusters = new Map<string, Row[]>();
  for (const r of hand) {
    const w = norm(r.text);
    if (w.length < 3) continue;
    const k = w.slice(0, 4).join(" ");
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k)!.push(r);
  }
  for (const [k, rs] of [...clusters].sort((a, b) => b[1].length - a[1].length).filter(([, rs]) => rs.length >= 3).slice(0, cap)) {
    out.push(`- ${rs.length}× "${k}…" — ${[...new Set(rs.map((r) => short(r.project)))].slice(0, 3).join(", ")}`);
    for (const r of rs.slice(0, 2)) out.push(`    ${r.ts.slice(0, 10)} ${one(r.text, 90)}`);
  }

  // Long prompts
  const long = hand.filter((r) => r.text.length > 700);
  out.push(`\n## Long hand-typed prompts (>700 chars): ${long.length}`);
  for (const r of long.slice(0, cap)) out.push(`- ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} len=${r.text.length} :: ${one(r.text, 90)}`);

  // Goals
  const goals = kinds.get("goal") ?? [];
  out.push(`\n## Stop-hook goals: ${goals.length}`);
  for (const r of goals.slice(0, cap)) out.push(`- ${r.ts.slice(0, 10)} ${short(r.project)} :: ${one(/condition: "([^"]*)"/.exec(r.text)?.[1] ?? r.text, 110)}`);

  // Projects
  out.push("\n## Hand-typed prompts per project");
  for (const [p, v] of sorted(counter(hand.map((r) => r.project))).slice(0, 15)) out.push(`- ${v} ${p}`);
  return out.join("\n");
}

// --- main -------------------------------------------------------------------
if (import.meta.main) {
  if (has("selfcheck")) {
    const sample = [
      "[2026-09-01T00:00 -Users-x-proj s1] fix the bug",
      "[2026-09-01T00:01 -Users-x-proj s1] [/retro 7d]",
      "[2026-09-01T00:01 -Users-x-proj s1] [/lint]",
      "[2026-09-01T00:02 -Users-x-proj s1] [skill:writing-for-agents]",
      "[2026-09-01T00:03 -Users-x-proj s1] Background agent \"Babysit PR #1\" was stopped by the user.",
      "[2026-09-01T00:04 -Users-x-proj s1] create atomic commits and PR",
      "[2026-09-01T00:05 -Users-x-proj s1] no. keep it",
      "[2026-09-01T00:06 -Users-x-proj s1] resume",
      "[2026-09-01T00:07 -Users-x-proj s1] Review recent sessions for workflow friction and encode the fixes",
      "continuation line of the body",
    ].join("\n");
    const rows = parsePrompts(sample);
    console.assert(rows.length === 9 && rows[8].text.includes("\ncontinuation"), "parsePrompts continuation");
    const kinds = rows.map((r) => classify(r.text));
    console.assert(JSON.stringify(kinds) === JSON.stringify(["hand", "typed-skill", "typed-skill", "loaded-skill", "harness", "hand", "hand", "hand", "body"]), `classify ${kinds}`);
    const rep = report(rows, 30, 10, "/nonexistent");
    console.assert(rep.includes("| retro | 1 | 0 |") && rep.includes("| lint | 1 | 0 |") && rep.includes("| writing-for-agents | 0 | 1 |"), "skill table");
    console.assert(rep.includes("commit-with-subagent: 1 gap / 1 hit"), "gap");
    console.assert(rep.includes("Correction openers: 1") && rep.includes("Nudges: 1"), "corrections/nudges");
    console.log("selfcheck ok");
  } else {
    const days = Number(arg("days", "30"));
    const cap = Number(arg("cap", "12"));
    const ledger = arg("ledger", join(homedir(), ".claude/rules-engine-state/audit.jsonl"));
    let dump: string;
    const file = arg("prompts", "");
    if (file) dump = readFileSync(file, "utf8");
    else {
      const cmd = ["bun", findChatlog(), "prompts", "--days", String(days), "--width", "0"];
      const project = arg("project", "");
      if (project) cmd.push("--project", project);
      const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
      if (proc.exitCode !== 0) process.exit(proc.exitCode);
      dump = proc.stdout.toString();
    }
    console.log(report(parsePrompts(dump), days, cap, ledger));
  }
}
