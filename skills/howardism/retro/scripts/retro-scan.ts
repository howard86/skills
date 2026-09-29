#!/usr/bin/env bun
// retro-scan: turn `chatlog prompts` output into the retro's evidence tables.
// Owns the noise filter (harness rows, skill markers, command bodies, goals) and every tally
// the retro reads: skill usage, corrections, nudges, repeats, long prompts, keyword→skill gaps.
//
//   bun retro-scan.ts [--days N] [--project sub] [--prompts file] [--cap N] [--briefs dir] [--per-brief N] [--no-jev] [--selfcheck]
//
// `--prompts file` reuses a saved `chatlog prompts --include-agents --width 0` dump instead of rescanning.
// `--briefs dir` also writes one worker brief per non-empty verification bucket
// (brief-nudges.md, brief-corrections.md, brief-gaps.md, brief-repeats.md): the same items the
// report lists, framed as questions a read-only subagent answers into dir/verdicts-<bucket>.md.
// A bucket over --per-brief items (default 24) splits into brief-<bucket>-1.md, -2.md, ... so one
// worker never owns more transcript reads than it can finish.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Row = { ts: string; project: string; sid: string; text: string; agent?: boolean };

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
  "commit-with-subagent": /\b(atomic commits?|create (a |another )?pr|create (the |these |atomic )?commits|open (a )?pr|draft pr|\bcommit)\b/i,
  "implement-with-subagent": /\b(subagent|sub-agent|delegate|with (sub-?)?agents)\b/i,
  "perf-": /\b(perf|performance|benchmark|bench|latency|hot ?path|faster|slow|alloc)\b/i,
  "chat-history": /\b(last time|did we|previous session|earlier session|what did (i|we)|chat-history)\b/i,
  "disk-cleanup": /\b(disk|free space|clean ?up large|stale worktrees)\b/i,
  "agent-status": /\b(stuck|seems stale|idle agents|still running|takes (this|so) long|verify states)\b/i,
  "research": /\bresearch\b/i,
  "writing-for-agents": /\b(skill|claude\.md|agents\.md|standing rule)\b/i,
  "resolving-merge-conflicts": /\bconflicts?\b/i,
};

// --- jev --------------------------------------------------------------------
// Jev (TypeSafe System One) reads each hand-typed prompt beside the regexes above. Its answers are
// gated like the helper's band(): >= JEV_ACT counts in the tables, JEV_CONFIRM..JEV_ACT reaches
// the briefs tagged `(jev 0.63, verify)`, lower is dropped. The regex sets are always computed, so
// every brief item the regex-only scan would write is still written, tagged `regex` or `both`.
const JEV_ACT = 0.8;
const JEV_CONFIRM = 0.5;
const JEV_USD_PER_MTOK = 0.042;
// One line per SKILL_KEYWORDS key: the job the skill does, so `wanted_skill` judges intent, not words.
const SKILL_JOBS: Record<keyof typeof SKILL_KEYWORDS, string> = {
  "rebase-babysit": "Rebase a PR branch onto its base, resolve conflicts, force-push, then watch its reviews and CI through merge or closure.",
  "commit-with-subagent": "Turn finished, approved changes into atomic commits, and push or open a draft PR when asked.",
  "implement-with-subagent": "Hand an approved implementation plan to a subagent worker, then verify and integrate its result.",
  "perf-": "Make code faster or cheaper: algorithmic wins, hot-path API shape, benchmarking and profiling, allocation and memory cuts, or stripping logging and indirection overhead.",
  "chat-history": "Search past session transcripts for an earlier decision, fix, error, or prompt.",
  "disk-cleanup": "Reclaim disk space on this Mac: large or unused files, stale worktrees, build caches.",
  "agent-status": "Check whether running subagents, background tasks, or remote runs are live, stuck, or stale, and clear idle ones.",
  "research": "Investigate a question against primary sources and write the findings up as a Markdown file.",
  "writing-for-agents": "Write or edit a skill, an AGENTS.md or CLAUDE.md, or another document an agent reads.",
  "resolving-merge-conflicts": "Resolve an in-progress git merge or rebase conflict.",
};
const JEV_QUESTIONS = {
  is_correction: {
    type: "noul",
    instructions: "Does this prompt open by correcting or reversing what the assistant just did?",
    criteria: {
      true: "The user rejects, undoes, or redirects the assistant's previous action or answer, e.g. 'no, keep the old name', 'revert that', 'I meant X, not Y'.",
      false: "The prompt gives a new task, asks a question, adds information, or approves; it does not push back on the assistant's last turn.",
    },
  },
  is_nudge: {
    type: "noul",
    instructions: "Is this prompt a bare nudge to keep going, with no new instruction?",
    criteria: {
      true: "Only a continue, retry, resume, yes, ok, or go on, carrying no new content.",
      false: "It carries a new instruction, question, correction, or information.",
    },
  },
  wanted_skill: {
    type: "choice",
    instructions: "Which job does this prompt ask the assistant to do? Pick none when it asks for none of these jobs or names their words only in passing.",
    criteria: { ...SKILL_JOBS, none: "Something else, or one of these topics mentioned only in passing." },
  },
} as const;

type JevVerdict = { correction: number; nudge: number; skill: string; skillConf: number };
export type JevRun = { status: string; verdicts: Map<Row, JevVerdict> | null; inputTokens: number };
type AskFn = (state: unknown, questions: typeof JEV_QUESTIONS) => Promise<{ answers: any; usage?: { input_tokens: number } }>;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

// Resolves the jev-decisions helper by sibling path, then the two deployed skill dirs.
async function loadJev(): Promise<{ ask: AskFn } | { reason: string }> {
  const candidates = [
    resolve(import.meta.dir, "../../jev-decisions/scripts/jev.ts"),
    join(homedir(), ".claude/skills/jev-decisions/scripts/jev.ts"),
    join(homedir(), ".agents/skills/jev-decisions/scripts/jev.ts"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) return { reason: "jev.ts not found" };
  try {
    const mod = await import(hit);
    await mod.apiKey();
    return { ask: (state, questions) => mod.ask(state, questions) };
  } catch (e) {
    return { reason: errText(e) };
  }
}

// One request per hand row, `concurrency` in flight. A 401/403 stops the run: every later call would fail the same way.
export async function jevClassify(hand: Row[], ask: AskFn, concurrency = 8): Promise<JevRun> {
  const verdicts = new Map<Row, JevVerdict>();
  let inputTokens = 0, failed = 0, firstError = "", stop = false, next = 0;
  const worker = async () => {
    while (!stop && next < hand.length) {
      const r = hand[next++];
      try {
        const { answers: a, usage } = await ask({ prompt: r.text.slice(0, 2000) }, JEV_QUESTIONS);
        verdicts.set(r, { correction: a.is_correction.noul, nudge: a.is_nudge.noul, skill: a.wanted_skill.choice, skillConf: a.wanted_skill.confidence });
        inputTokens += usage?.input_tokens ?? 0;
      } catch (e) {
        failed++;
        firstError ||= errText(e);
        if ([401, 403].includes((e as { status?: number }).status ?? 0)) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hand.length) }, worker));
  if (hand.length && !verdicts.size) return { status: `jev: unavailable (${firstError}), regex only`, verdicts: null, inputTokens };
  const fail = failed ? `, ${failed} failed (${firstError}); failed rows are regex only` : "";
  return { status: `jev: ${verdicts.size}/${hand.length} hand-typed prompts classified${fail}; counts at >= ${JEV_ACT}, briefs tag ${JEV_CONFIRM} to ${JEV_ACT} as verify`, verdicts, inputTokens };
}

// Regex set vs Jev set over one bucket. `pool` holds every candidate row (the regex set is a subset);
// `score` is the row's Jev probability for this bucket. The brief keeps the first `limit` regex rows
// (what the regex-only scan wrote) plus the first `limit` Jev-only rows at >= JEV_CONFIRM, in pool order.
type Tag = { kind: "both" | "regex" | "jev" | null; verify?: number };
type Merged = { line: string; both: Row[]; onlyRegex: Row[]; onlyJev: Row[]; brief: { row: Row; tag: Tag }[] };
export function merge(regex: Row[], pool: Row[], score: (r: Row) => number | undefined, limit: number): Merged {
  const s = (r: Row) => score(r) ?? 0;
  const inRegex = new Set(regex);
  const act = new Set(pool.filter((r) => s(r) >= JEV_ACT));
  const verify = pool.filter((r) => s(r) >= JEV_CONFIRM && s(r) < JEV_ACT);
  const both = regex.filter((r) => act.has(r));
  const onlyRegex = regex.filter((r) => !act.has(r));
  const onlyJev = [...act].filter((r) => !inRegex.has(r));
  const keep = new Set([...regex.slice(0, limit), ...pool.filter((r) => !inRegex.has(r) && s(r) >= JEV_CONFIRM).slice(0, limit)]);
  const tagOf = (r: Row): Tag => {
    const v = s(r) >= JEV_CONFIRM && s(r) < JEV_ACT ? s(r) : undefined;
    return { kind: inRegex.has(r) ? (act.has(r) ? "both" : "regex") : act.has(r) ? "jev" : null, verify: v };
  };
  return {
    line: `regex ${regex.length} / jev ${act.size} (both ${both.length}, regex-only ${onlyRegex.length}, jev-only ${onlyJev.length}); verify band ${verify.length}`,
    both, onlyRegex, onlyJev,
    brief: pool.filter((r) => keep.has(r)).map((row) => ({ row, tag: tagOf(row) })),
  };
}
// Renders one or more tags as `(both)`, `(regex) (jev 0.63, verify)`, `(jev)`; several rows' tags merge into one.
export function fmtTags(tags: Tag[]): string {
  const kinds = [...new Set(tags.map((t) => t.kind).filter(Boolean))].map((k) => `(${k})`);
  const v = tags.map((t) => t.verify).filter((x): x is number => x !== undefined);
  if (v.length) kinds.push(`(jev ${Math.min(...v).toFixed(2)}, verify)`);
  return kinds.join(" ");
}

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
  const head = /^\[(\S+) (\S+) (\S+)( agent)?\] (.*)$/;
  for (const line of dump.split("\n")) {
    const m = head.exec(line);
    if (m) rows.push({ ts: m[1], project: m[2], sid: m[3], text: m[5], ...(m[4] ? { agent: true } : {}) });
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

// --- briefs -----------------------------------------------------------------
// One bucket per independent verification question. Items are appended by report(); the
// header states the question, the tool, and the return contract, so the root never re-types them.
type Bucket = "nudges" | "corrections" | "gaps" | "repeats";
const BRIEF_QUESTION: Record<Bucket, string> = {
  nudges: "For each session below, what preceded its `resume`/`continue` turns: an API, auth, or network error (`529`, `401`, `ENOTFOUND`), a spend or usage limit, the machine sleeping, a completed report the user merely re-ran, or a genuine mid-task stop. Only the last is friction; say which.",
  corrections: "For each correction below, what did the previous assistant turn do, and does a line in the global instructions file, a rules-engine rule, or a memory file already cover it (name the file), or is it a standing-rule gap.",
  gaps: "For each prompt below, the session never loaded the skill in brackets. Would that skill have applied to the prompt, or was the keyword incidental.",
  repeats: "For each cluster below, `search` its key terms and say whether two sessions solved the same task (re-done work) or the repeats were distinct tasks or automation echoes.",
};
export function renderBrief(bucket: Bucket, items: string[], days: number, chatlog: string, dir: string, part = ""): string {
  return [
    `# retro verification: ${bucket}${part} (last ${days}d)`,
    "",
    "Role and mode: read-only reader, model sonnet, inherited effort. Write nothing outside the directory named below.",
    `Question: ${BRIEF_QUESTION[bucket]}`,
    `Tool: bun ${chatlog} show <sid> --grep <re> [--tools] for the turns around a prompt; bun ${chatlog} search <query> --days ${days} [--paths-only] for other sessions. Slice with --grep, --tail, --width; never dump a whole transcript.`,
    "Standing rules to check against (corrections only): ~/.claude/CLAUDE.md, ~/claude/agent-plugins/rules-engine/rules/*.md, ~/.claude/projects/<project>/memory/*.md.",
    `Deliverable: write one line per item, \`verdict: evidence (sid)\`, to ${dir}/verdicts-${bucket}${part}.md, keeping the items' order. Reply with only the item count and that path.`,
    "Stop: every item has a line. Spawn no further agents. An unreadable transcript gets `unreadable: <error> (sid)`.",
    "",
    `Items (${items.length}):`,
    ...items,
    "",
  ].join("\n");
}

// --- report -----------------------------------------------------------------
function harnessProjectsOf(rows: Row[]): Set<string> {
  const home = "-" + homedir().replace(/\//g, "-");
  // Harness projects: every session holds exactly one prompt (eval fixtures, cron).
  const perProject = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!perProject.has(r.project)) perProject.set(r.project, new Map());
    const s = perProject.get(r.project)!;
    s.set(r.sid, (s.get(r.sid) ?? 0) + 1);
  }
  return new Set(
    [...perProject].filter(([p, s]) => p === home || p.startsWith("-private-tmp") || (s.size >= 3 && [...s.values()].every((v) => v === 1))).map(([p]) => p),
  );
}
// The rows report() treats as hand-typed: the set Jev classifies.
export function handRows(rows: Row[]): Row[] {
  const hp = harnessProjectsOf(rows);
  return rows.filter((r) => !r.agent && !hp.has(r.project) && classify(r.text) === "hand");
}

export function report(allRows: Row[], days: number, cap: number, ledger: string, jev?: JevRun): { text: string; briefs: Record<Bucket, string[]> } {
  // Worker rows (subagent transcripts) feed only the skill table's `worker` column.
  const rows = allRows.filter((r) => !r.agent);
  const workerLoads = allRows.filter((r) => r.agent && classify(r.text) === "loaded-skill");
  const out: string[] = [];
  const briefs: Record<Bucket, string[]> = { nudges: [], corrections: [], gaps: [], repeats: [] };
  const harnessProjects = harnessProjectsOf(rows);
  const V = jev?.verdicts ?? null;
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

  out.push(`# retro-scan: last ${days}d, ${rows.length} rows, ${hand.length} hand-typed`);
  out.push(`dropped: harness projects ${harnessProjects.size} (${[...harnessProjects].map(short).join(", ") || "none"}); harness rows ${(kinds.get("harness") ?? []).length}; command bodies ${(kinds.get("body") ?? []).length}`);
  if (jev) out.push(jev.status);
  // Jev calibration: each bucket prints the regex/Jev overlap and up to `cap` rows each side missed.
  const examples = (m: Merged, indent: string, fmt: (r: Row) => string) => {
    for (const [label, rs] of [["regex-only", m.onlyRegex], ["jev-only", m.onlyJev]] as const) {
      if (!rs.length) continue;
      out.push(`${indent}${label}:`);
      for (const r of rs.slice(0, cap)) out.push(`${indent}  ${fmt(r)}`);
    }
  };

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
  if (!ledgerRows.length) out.push(`0 rows (ledger starts ${ledgerFirst || "n/a"}; pushback rules exist since 2026-09-18, expected when no anchored correction was typed; the corrections section below is the fallback)`);
  for (const r of ledgerRows) {
    out.push(`- ${r.ts.slice(0, 16)} ${r.rule} ${short(r.cwd ?? "")} ${String(r.session).slice(0, 8)} :: ${one(String(r.detail ?? ""))}`);
    briefs.corrections.push(`- ledger ${r.rule} ${r.ts.slice(0, 16)} ${String(r.session).slice(0, 8)} (${short(r.cwd ?? "")}) :: ${one(String(r.detail ?? ""), 200)}`);
  }

  // Skills
  out.push("\n## Skill usage (typed `/x` vs assistant-loaded)");
  const bySkill = new Map<string, { typed: number; loaded: number; worker: number; projects: Set<string>; first: string; last: string }>();
  for (const r of [...typed, ...loaded]) {
    const n = skillOf(r.text);
    const e = bySkill.get(n) ?? { typed: 0, loaded: 0, worker: 0, projects: new Set(), first: r.ts, last: r.ts };
    if (classify(r.text) === "typed-skill") e.typed++; else e.loaded++;
    e.projects.add(r.project);
    if (r.ts < e.first) e.first = r.ts;
    if (r.ts > e.last) e.last = r.ts;
    bySkill.set(n, e);
  }
  for (const r of workerLoads) {
    if (harnessProjects.has(r.project)) continue;
    const n = skillOf(r.text);
    const e = bySkill.get(n) ?? { typed: 0, loaded: 0, worker: 0, projects: new Set(), first: r.ts, last: r.ts };
    e.worker++;
    e.projects.add(r.project);
    if (r.ts < e.first) e.first = r.ts;
    if (r.ts > e.last) e.last = r.ts;
    bySkill.set(n, e);
  }
  out.push("| skill | typed | loaded | worker | projects | first | last |\n|---|---|---|---|---|---|---|");
  const total = (e: { typed: number; loaded: number; worker: number }) => e.typed + e.loaded + e.worker;
  for (const [n, e] of [...bySkill].sort((a, b) => total(b[1]) - total(a[1])))
    out.push(`| ${n} | ${e.typed} | ${e.loaded} | ${e.worker} | ${e.projects.size} | ${e.first.slice(0, 10)} | ${e.last.slice(0, 10)} |`);
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
    if (V) {
      const score = (r: Row) => (V.get(r)?.skill === skill ? V.get(r)!.skillConf : undefined);
      const m = merge(gaps, hand.filter((r) => !loadedIn(r.sid, skill)), score, Math.min(cap, 6));
      if (!hits.length && !m.brief.length) continue;
      out.push(`- ${skill}: ${gaps.length} gap / ${hits.length} hit`);
      out.push(`    gaps: ${m.line}`);
      examples(m, "    ", (r) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 90)}`);
      for (const { row: r, tag } of m.brief) briefs.gaps.push(`- [${skill}] ${fmtTags([tag])} ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 160)}`);
      continue;
    }
    if (!hits.length) continue;
    out.push(`- ${skill}: ${gaps.length} gap / ${hits.length} hit`);
    for (const r of gaps.slice(0, Math.min(cap, 6))) {
      out.push(`    ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 90)}`);
      briefs.gaps.push(`- [${skill}] ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 160)}`);
    }
  }

  // Corrections
  const corrections = hand.filter((r) => CORRECTION_RE.test(r.text));
  out.push(`\n## Correction openers: ${corrections.length}`);
  if (V) {
    const score = (r: Row) => V.get(r)?.correction;
    const m = merge(corrections, hand, score, cap * 2);
    const fmt = (r: Row) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 140)}`;
    out.push(m.line);
    for (const r of m.both.slice(0, cap)) out.push(`- (both) ${fmt(r)}`);
    examples(m, "", fmt);
    for (const { row: r, tag } of m.brief) briefs.corrections.push(`- ${fmtTags([tag])} ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 200)}`);
  } else for (const r of corrections.slice(0, cap * 2)) {
    out.push(`- ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 140)}`);
    briefs.corrections.push(`- ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 200)}`);
  }

  // Nudges
  const nudges = hand.filter((r) => NUDGE_RE.test(r.text));
  out.push(`\n## Nudges: ${nudges.length} (verify the cause per session: \`chatlog show <sid> --grep "529|limit|Overloaded"\`)`);
  const nudgeBySid = counter(nudges.map((r) => `${short(r.project)} ${r.sid}`));
  if (V) {
    // Sessions: the regex scan's top `cap` plus the top `cap` by Jev-only rows; each lists all its union rows.
    const score = (r: Row) => V.get(r)?.nudge;
    const m = merge(nudges, hand, score, Infinity);
    out.push(m.line);
    examples(m, "", (r) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 60)}`);
    const inRegex = new Set(nudges);
    const top = (rs: Row[]) => sorted(counter(rs.map((r) => r.sid))).slice(0, cap).map(([sid]) => sid);
    const sids = new Set([...top(nudges), ...top(m.brief.map((p) => p.row).filter((r) => !inRegex.has(r)))]);
    const sessions = [...sids].map((sid) => m.brief.filter((p) => p.row.sid === sid)).sort((a, b) => b.length - a.length);
    for (const ps of sessions) {
      const r0 = ps[0].row, tags = fmtTags(ps.map((p) => p.tag));
      out.push(`- ${ps.length}× ${short(r0.project)} ${r0.sid} ${tags}`);
      briefs.nudges.push(`- ${tags} ${r0.sid} (${short(r0.project)}) ${ps.length}× at ${ps.map((p) => p.row.ts.slice(11, 16)).slice(0, 6).join(", ")}`);
    }
  } else for (const [k, v] of sorted(nudgeBySid).slice(0, cap)) {
    out.push(`- ${v}× ${k}`);
    const sid = k.split(" ")[1];
    const at = nudges.filter((r) => r.sid === sid).map((r) => r.ts.slice(11, 16)).slice(0, 6).join(", ");
    briefs.nudges.push(`- ${sid} (${k.split(" ")[0]}) ${v}× at ${at}`);
  }

  // Repeats
  out.push("\n## Repeated prompts");
  const exact = counter(hand.map((r) => norm(r.text).join(" ")).filter((s) => s.length > 2));
  for (const [k, v] of sorted(exact).filter(([, v]) => v >= 2).slice(0, cap)) {
    out.push(`- ${v}× exact: ${one(k, 90)}`);
    if (NUDGE_RE.test(k)) continue; // a repeated nudge is the nudges bucket's item, not re-done work
    const sids = [...new Set(hand.filter((r) => norm(r.text).join(" ") === k).map((r) => r.sid))];
    briefs.repeats.push(`- ${v}× exact "${one(k, 90)}" in ${sids.slice(0, 4).join(", ")}`);
  }
  const clusters = new Map<string, Row[]>();
  for (const r of hand) {
    const w = norm(r.text);
    if (w.length < 3) continue;
    const k = w.slice(0, 4).join(" ");
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k)!.push(r);
  }
  for (const [k, rs] of [...clusters].sort((a, b) => b[1].length - a[1].length).filter(([, rs]) => rs.length >= 3).slice(0, cap)) {
    out.push(`- ${rs.length}× "${k}…" in ${[...new Set(rs.map((r) => short(r.project)))].slice(0, 3).join(", ")}`);
    for (const r of rs.slice(0, 2)) out.push(`    ${r.ts.slice(0, 10)} ${one(r.text, 90)}`);
    briefs.repeats.push(`- ${rs.length}× "${k}…" in ${[...new Set(rs.map((r) => r.sid))].slice(0, 4).join(", ")} :: e.g. ${one(rs[0].text, 120)}`);
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
  if (V) out.push(`\njev cost: ${V.size} requests, ${jev!.inputTokens} input tokens, $${((jev!.inputTokens / 1e6) * JEV_USD_PER_MTOK).toFixed(4)} at $${JEV_USD_PER_MTOK}/M`);
  return { text: out.join("\n"), briefs };
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
    const agentRow: Row = { ts: "2026-09-01T00:08", project: "-Users-x-proj", sid: "a1", text: "[skill:perf-algorithms]", agent: true };
    const rows = parsePrompts(sample);
    console.assert(rows.length === 9 && rows[8].text.includes("\ncontinuation"), "parsePrompts continuation");
    const kinds = rows.map((r) => classify(r.text));
    console.assert(JSON.stringify(kinds) === JSON.stringify(["hand", "typed-skill", "typed-skill", "loaded-skill", "harness", "hand", "hand", "hand", "body"]), `classify ${kinds}`);
    const { text: rep, briefs } = report([...rows, agentRow], 30, 10, "/nonexistent");
    console.assert(rep.includes("| retro | 1 | 0 | 0 |") && rep.includes("| lint | 1 | 0 | 0 |") && rep.includes("| writing-for-agents | 0 | 1 | 0 |") && rep.includes("| perf-algorithms | 0 | 0 | 1 | 1 |") && rep.includes("9 rows"), "skill table");
    console.assert(SKILL_KEYWORDS["commit-with-subagent"].test("create the commits") && !SKILL_KEYWORDS["implement-with-subagent"].test("implement the fix") && SKILL_KEYWORDS["implement-with-subagent"].test("do it with subagents"), "keyword patterns");
    console.assert(rep.includes("commit-with-subagent: 1 gap / 1 hit"), "gap");
    console.assert(rep.includes("Correction openers: 1") && rep.includes("Nudges: 1"), "corrections/nudges");
    console.assert(briefs.gaps.length === 1 && briefs.gaps[0].startsWith("- [commit-with-subagent] ") && briefs.gaps[0].includes(" s1 "), `briefs.gaps ${briefs.gaps}`);
    console.assert(briefs.corrections.length === 1 && briefs.corrections[0].includes("no. keep it"), `briefs.corrections ${briefs.corrections}`);
    console.assert(briefs.nudges.length === 1 && briefs.nudges[0].startsWith("- s1 ") && briefs.nudges[0].includes("1× at 00:06"), `briefs.nudges ${briefs.nudges}`);
    console.assert(briefs.repeats.length === 0, "briefs.repeats empty");
    const b = renderBrief("nudges", briefs.nudges, 30, "/x/chatlog.ts", "/tmp/r");
    console.assert(b.includes("Items (1):") && b.includes("/tmp/r/verdicts-nudges.md") && b.includes("bun /x/chatlog.ts show"), "renderBrief");
    console.assert(renderBrief("gaps", ["- x"], 30, "/x/chatlog.ts", "/tmp/r", "-2").includes("/tmp/r/verdicts-gaps-2.md"), "renderBrief part");
    // Jev path with a stubbed ask: union and tags, no network.
    console.assert(JSON.stringify(Object.keys(SKILL_JOBS)) === JSON.stringify(Object.keys(SKILL_KEYWORDS)), "SKILL_JOBS keys");
    const stub: Record<string, [number, number, string, number]> = {
      "fix the bug": [0.6, 0.1, "none", 0.9], // correction in the verify band, jev-only
      "create atomic commits and PR": [0.05, 0.1, "commit-with-subagent", 0.9], // gap: both
      "no. keep it": [0.9, 0.1, "none", 0.9], // correction: both
      resume: [0.1, 0.95, "none", 0.9], // nudge: both
    };
    const ask: AskFn = async (state) => {
      const [c, n, skill, conf] = stub[(state as { prompt: string }).prompt];
      return { answers: { is_correction: { noul: c }, is_nudge: { noul: n }, wanted_skill: { choice: skill, confidence: conf } }, usage: { input_tokens: 10 } };
    };
    const run = await jevClassify(handRows(rows), ask);
    console.assert(run.verdicts?.size === 4 && run.inputTokens === 40, `jevClassify ${run.status}`);
    const { text: jrep, briefs: jb } = report(rows, 30, 10, "/nonexistent", run);
    console.assert(jrep.includes("regex 1 / jev 1 (both 1, regex-only 0, jev-only 0); verify band 1") && jrep.includes("jev cost: 4 requests, 40 input tokens"), "jev counts");
    console.assert(jb.corrections.length === 2 && jb.corrections[0].startsWith("- (jev 0.60, verify) ") && jb.corrections[1].startsWith("- (both) "), `jev briefs.corrections ${jb.corrections}`);
    console.assert(jb.gaps.length === 1 && jb.gaps[0].startsWith("- [commit-with-subagent] (both) "), `jev briefs.gaps ${jb.gaps}`);
    console.assert(jb.nudges.length === 1 && jb.nudges[0].startsWith("- (both) s1 "), `jev briefs.nudges ${jb.nudges}`);
    console.assert(fmtTags([{ kind: "regex", verify: 0.7 }, { kind: "jev" }, { kind: null, verify: 0.55 }]) === "(regex) (jev) (jev 0.55, verify)", "fmtTags");
    console.log("selfcheck ok");
  } else {
    const days = Number(arg("days", "30"));
    const cap = Number(arg("cap", "12"));
    const ledger = arg("ledger", join(homedir(), ".claude/rules-engine-state/audit.jsonl"));
    let dump: string;
    const file = arg("prompts", "");
    if (file) dump = readFileSync(file, "utf8");
    else {
      const cmd = ["bun", findChatlog(), "prompts", "--days", String(days), "--include-agents", "--width", "0"];
      const project = arg("project", "");
      if (project) cmd.push("--project", project);
      const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
      if (proc.exitCode !== 0) process.exit(proc.exitCode);
      dump = proc.stdout.toString();
    }
    const rows = parsePrompts(dump);
    let jev: JevRun = { status: "jev: off (--no-jev), regex only", verdicts: null, inputTokens: 0 };
    if (!has("no-jev")) {
      const j = await loadJev();
      if ("reason" in j) jev = { status: `jev: unavailable (${j.reason}), regex only`, verdicts: null, inputTokens: 0 };
      else {
        const hand = handRows(rows);
        console.error(`jev: classifying ${hand.length} hand-typed prompts, 8 in flight`);
        jev = await jevClassify(hand, j.ask);
      }
    }
    const { text, briefs } = report(rows, days, cap, ledger, jev);
    console.log(text);
    const dir = arg("briefs", "");
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      const per = Number(arg("per-brief", "24"));
      for (const [bucket, items] of Object.entries(briefs) as [Bucket, string[]][]) {
        if (!items.length) continue;
        const parts = items.length > per ? Math.ceil(items.length / per) : 1;
        for (let i = 0; i < parts; i++) {
          const part = parts > 1 ? `-${i + 1}` : "";
          const chunk = items.slice(i * per, (i + 1) * per);
          const path = join(dir, `brief-${bucket}${part}.md`);
          writeFileSync(path, renderBrief(bucket, chunk, days, findChatlog(), resolve(dir), part));
          written.push(`${path} (${chunk.length} items)`);
        }
      }
      console.error(written.length ? `briefs written:\n  ${written.join("\n  ")}` : "briefs: no items in any bucket");
    }
  }
}
