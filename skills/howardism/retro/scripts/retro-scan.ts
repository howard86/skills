#!/usr/bin/env bun
// retro-scan: turn `chatlog prompts` output into the retro's evidence tables.
// Owns the noise filter (harness rows, skill markers, command bodies, goals) and every tally
// the retro reads: skill usage, corrections, nudges, repeats, long prompts, keyword→skill gaps.
//
//   bun retro-scan.ts [--days N] [--project sub] [--exclude sid,sid] [--prompts file] [--cap N] [--briefs dir] [--per-brief N] [--no-jev] [--jev-act x] [--verify-all] [--selfcheck]
// `--exclude` drops every row of the named sessions (prefix match on the session id): the retro's own session, whose prompts name the skills it is auditing.
//
// `--prompts file` reuses a saved `chatlog prompts --include-agents --width 0` dump instead of rescanning.
// `--briefs dir` also writes one worker brief per non-empty verification bucket
// (brief-nudges.md, brief-corrections.md, brief-gaps.md, brief-repeats.md): the same items the
// report lists, framed as questions a read-only subagent answers into dir/verdicts-<bucket>.md.
// With Jev, a gap item Jev settles (its wanted_skill is that skill at >= --jev-act, default 0.8) stays
// out of the briefs and is listed in scan.md under "settled by jev"; every 5th settled item goes to
// the brief anyway, tagged `(jev 0.93, audit)`, so calibration keeps labels at the top band.
// --verify-all disables settling. --briefs also writes items.jsonl: one row per brief item (brief
// file, index, Jev probability, settled flag) plus the settled ones, the input of retro-calibrate.ts.
// A bucket over --per-brief items (default 24) splits into brief-<bucket>-1.md, -2.md, ... so one
// worker never owns more transcript reads than it can finish.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Row = { ts: string; project: string; sid: string; text: string; agent?: boolean; prev?: string };

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
  "Distill an alpha family", "# Update Config Skill", "Run .claude/commands/research-cycle.md",
];
// A short prompt that answers a question the assistant just asked ("yes" to a force-push question, "1" to a menu)
// is not a nudge: `prev` ends in a question mark, carries an option list, or offers ("Want me to").
const OPTION_LINE_RE = /^\s*(\d+\.|-)\s+\S.{0,40}$/gm;
export function isAnswer(prev?: string): boolean {
  if (!prev) return false;
  const t = prev.trim();
  return /\?[\s*_)"'`\]]*$/.test(t) || (t.match(OPTION_LINE_RE)?.length ?? 0) >= 2 || /\b(want me to|should i|shall i)\b/i.test(t);
}
const NUDGE_RE = /^\s*(continue|retry|resume|go on|proceed|yes|ok|y)\s*[.!]?\s*$/i;
// Wider than the rules engine's `pushback` anchor: it also catches the openers the ledger misses.
const CORRECTION_RE = /^\s*(no|nope|don'?t|dont|correction|actually|i mean|instead|revert|discard|prefer|turn off|wrong|stop|wait|undo|remove)\b/i;
// Prompts that name a skill's job without naming the skill. A hit counts as a gap when no
// marker for that skill appears in the same session.
const SKILL_KEYWORDS: Record<string, RegExp> = {
  "rebase-pr": /\b(rebase|rescue (the|this) pr|stale pr)\b/i,
  "babysit-pr": /\b(babysit|watch ci)\b/i,
  "commit-with-subagent": /\b(atomic commits?|create (a |another )?pr|create (the |these |atomic )?commits|open (a )?pr|draft pr|\bcommit)\b/i,
  "implement-with-subagent": /\b(subagent|sub-agent|delegate|with (sub-?)?agents)\b/i,
  "perf-": /\b(latency|hot[ -]?path|micro-?benchmark|benchmark|bench|alloc(ation)?s?|throughput|p99|profil(e|ing)|optimi[sz]\w*\W+(\w+\W+){0,3}(code|function|loop|query|algorithm|memory|hot ?path)|(code|function|loop|query|algorithm|memory)\W+(\w+\W+){0,3}optimi[sz]\w*)\b/i,
  "chat-history": /\b(last time|did we|previous session|earlier session|what did (i|we)|chat-history)\b/i,
  "disk-cleanup": /\b(disk|free space|clean ?up large|stale worktrees)\b/i,
  "agent-status": /\b(stuck|seems stale|idle agents|still running|takes (this|so) long|verify states)\b/i,
  "research": /\bresearch\b/i,
  "writing-for-agents": /\b(skill|claude\.md|agents\.md|standing rule)\b/i,
  "resolving-merge-conflicts": /\bconflicts?\b/i,
};
// A skill renamed or split keeps its gap history: a marker for the old name counts as a load of the new one.
const SKILL_ALIASES: Record<string, string[]> = {
  "rebase-pr": ["rebase-babysit"],
  "babysit-pr": ["rebase-babysit"],
  "commit-with-subagent": ["commit-and-pr-with-sonnet"],
  "implement-with-subagent": ["implement-plan-with-sonnet"],
};
// A prompt older than the skill is not a gap: nothing could have loaded. Birth dates from git.
const SKILL_SINCE: Record<string, string> = {
  "agent-status": "2026-09-16",
  "disk-cleanup": "2026-09-16",
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
  "rebase-pr": "Rebase a PR branch onto its remote base, resolve conflicts, and force-push.",
  "babysit-pr": "Watch a PR's CI and review threads through merge-ready, merge, or closure.",
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
// Short prompts ("babysit", "verify states") carry their meaning in the assistant turn they answer.
const PREV_NOTE = " If previous_reply is present, read it only to see what a short prompt refers to; judge the prompt itself.";
const JEV_QUESTIONS = {
  is_correction: {
    type: "noul",
    instructions: "Does this prompt open by correcting or reversing what the assistant just did?" + PREV_NOTE,
    criteria: {
      true: "The user rejects, undoes, or redirects the assistant's previous action or answer, e.g. 'no, keep the old name', 'revert that', 'I meant X, not Y'.",
      false: "The prompt gives a new task, asks a question, adds information, or approves; it does not push back on the assistant's last turn.",
    },
  },
  is_nudge: {
    type: "noul",
    instructions: "Is this prompt a bare nudge to keep going, with no new instruction?" + PREV_NOTE,
    criteria: {
      true: "Only a continue, retry, resume, yes, ok, or go on, carrying no new content.",
      false: "It carries a new instruction, question, correction, or information.",
    },
  },
  wanted_skill: {
    type: "choice",
    instructions: "Which job does this prompt ask the assistant to do? Pick none when it asks for none of these jobs or names their words only in passing." + PREV_NOTE,
    criteria: { ...SKILL_JOBS, none: "Something else, or one of these topics mentioned only in passing." },
  },
} as const;

type JevVerdict = { correction: number; nudge: number; skill: string; skillConf: number };
export type JevRun = { status: string; verdicts: Map<Row, JevVerdict> | null; inputTokens: number; model?: string };
type AskFn = (state: unknown, questions: typeof JEV_QUESTIONS) => Promise<{ answers: any; usage?: { input_tokens: number }; model?: string }>;
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
export async function jevClassify(hand: Row[], ask: AskFn, concurrency = 8, act = JEV_ACT): Promise<JevRun> {
  const verdicts = new Map<Row, JevVerdict>();
  let inputTokens = 0, failed = 0, firstError = "", stop = false, next = 0, model: string | undefined;
  const worker = async () => {
    while (!stop && next < hand.length) {
      const r = hand[next++];
      try {
        const { answers: a, usage, model: m } = await ask({ prompt: r.text.slice(0, 2000), ...(r.prev ? { previous_reply: r.prev.slice(-600) } : {}) }, JEV_QUESTIONS);
        verdicts.set(r, { correction: a.is_correction.noul, nudge: a.is_nudge.noul, skill: a.wanted_skill.choice, skillConf: a.wanted_skill.confidence });
        inputTokens += usage?.input_tokens ?? 0;
        model ||= m;
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
  return { status: `jev: ${verdicts.size}/${hand.length} hand-typed prompts classified${fail}; counts at >= ${act}, briefs tag ${JEV_CONFIRM} to ${act} as verify; model ${model ?? "unknown"}`, verdicts, inputTokens, model };
}

// Regex set vs Jev set over one bucket. `pool` holds every candidate row (the regex set is a subset);
// `score` is the row's Jev probability for this bucket. The brief keeps the first `limit` regex rows
// (what the regex-only scan wrote) plus the first `limit` Jev-only rows at >= JEV_CONFIRM, in pool order.
type Tag = { kind: "both" | "regex" | "jev" | null; verify?: number; audit?: number };
type Merged = { line: string; both: Row[]; onlyRegex: Row[]; onlyJev: Row[]; brief: { row: Row; tag: Tag }[] };
export function merge(regex: Row[], pool: Row[], score: (r: Row) => number | undefined, limit: number, jevAct = JEV_ACT): Merged {
  const s = (r: Row) => score(r) ?? 0;
  const inRegex = new Set(regex);
  const act = new Set(pool.filter((r) => s(r) >= jevAct));
  const verify = pool.filter((r) => s(r) >= JEV_CONFIRM && s(r) < jevAct);
  const both = regex.filter((r) => act.has(r));
  const onlyRegex = regex.filter((r) => !act.has(r));
  const onlyJev = [...act].filter((r) => !inRegex.has(r));
  const keep = new Set([...regex.slice(0, limit), ...pool.filter((r) => !inRegex.has(r) && s(r) >= JEV_CONFIRM).slice(0, limit)]);
  const tagOf = (r: Row): Tag => {
    const v = s(r) >= JEV_CONFIRM && s(r) < jevAct ? s(r) : undefined;
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
  const a = tags.map((t) => t.audit).filter((x): x is number => x !== undefined);
  if (a.length) kinds.push(`(jev ${Math.min(...a).toFixed(2)}, audit)`);
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

const PREV_LINE = "  ^prev: ";
export function parsePrompts(dump: string): Row[] {
  const rows: Row[] = [];
  const head = /^\[(\S+) (\S+) (\S+)( agent)?\] (.*)$/;
  for (const line of dump.split("\n")) {
    const m = head.exec(line);
    if (m) rows.push({ ts: m[1], project: m[2], sid: m[3], text: m[5], ...(m[4] ? { agent: true } : {}) });
    else if (rows.length && line.startsWith(PREV_LINE)) rows[rows.length - 1].prev = line.slice(PREV_LINE.length); // from `chatlog prompts --prev`
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
// A ScheduleWakeup (/loop) tick re-sends the user's prompt verbatim every interval, so one hand-typed bootstrap
// shows up as N identical rows in one session. Keep the first, drop the echoes. Short prompts ("resume",
// "continue") are genuinely retyped and stay; a 100-character status poll typed three times is a tick.
export const ECHO_MIN_CHARS = 80, ECHO_MIN_REPEATS = 3;
const echoKey = (r: Row) => r.sid + "\0" + r.text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
export function dropAutomationEchoes(rows: Row[]): { rows: Row[]; dropped: number } {
  const n = new Map<string, number>();
  for (const r of rows) if (!r.agent && r.text.length >= ECHO_MIN_CHARS) { const k = echoKey(r); n.set(k, (n.get(k) ?? 0) + 1); }
  const seen = new Set<string>();
  let dropped = 0;
  const kept = rows.filter((r) => {
    if (r.agent || r.text.length < ECHO_MIN_CHARS) return true;
    const k = echoKey(r);
    if ((n.get(k) ?? 0) < ECHO_MIN_REPEATS) return true;
    if (seen.has(k)) { dropped++; return false; }
    seen.add(k); return true;
  });
  return { rows: kept, dropped };
}
// `--exclude a1b2c3d4,...`: every row of those sessions goes, worker rows included (prefix match, so the
// 8-character id the tables print is enough).
export function excludeSessions(rows: Row[], list: string): { rows: Row[]; dropped: number; sessions: number } {
  const ids = list.split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return { rows, dropped: 0, sessions: 0 };
  const hit = new Set<string>();
  const kept = rows.filter((r) => { const m = ids.some((id) => r.sid.startsWith(id)); if (m) hit.add(r.sid); return !m; });
  return { rows: kept, dropped: rows.length - kept.length, sessions: hit.size };
}
// The rows report() treats as hand-typed: the set Jev classifies.
export function handRows(rows: Row[]): Row[] {
  const hp = harnessProjectsOf(rows);
  return rows.filter((r) => !r.agent && !hp.has(r.project) && classify(r.text) === "hand");
}

// One row per brief item (same order as briefs[bucket]) for items.jsonl. `jev` is the probability for the
// item's own question: null when Jev did not run on the row, 0 when it ran and answered otherwise.
export type Rec = { bucket: Bucket; skill?: string; ts: string; sid: string; project: string; text: string; regex: boolean; jev: number | null; settled?: boolean };
export type ReportOpts = { act?: number; verifyAll?: boolean };
// Every 5th settled item is audited (index 0, 5, 10, ...), so any non-empty settled set keeps at least one.
export const isAudit = (i: number) => i % 5 === 0;

export function report(allRows: Row[], days: number, cap: number, ledger: string, jev?: JevRun, opts: ReportOpts = {}): { text: string; briefs: Record<Bucket, string[]>; recs: Record<Bucket, Rec[]>; settled: Rec[] } {
  const act = opts.act ?? JEV_ACT;
  // Worker rows (subagent transcripts) feed only the skill table's `worker` column.
  const rows = allRows.filter((r) => !r.agent);
  const workerLoads = allRows.filter((r) => r.agent && classify(r.text) === "loaded-skill");
  const out: string[] = [];
  const briefs: Record<Bucket, string[]> = { nudges: [], corrections: [], gaps: [], repeats: [] };
  const recs: Record<Bucket, Rec[]> = { nudges: [], corrections: [], gaps: [], repeats: [] };
  const settled: Rec[] = [];
  const add = (bucket: Bucket, line: string, rec: Omit<Rec, "bucket">) => { briefs[bucket].push(line); recs[bucket].push({ bucket, ...rec }); };
  const recOf = (r: Row, regex: boolean, jevP: number | null, more: Partial<Rec> = {}): Omit<Rec, "bucket"> => ({ ts: r.ts, sid: r.sid, project: r.project, text: r.text, regex, jev: jevP, ...more });
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
    add("corrections", `- ledger ${r.rule} ${r.ts.slice(0, 16)} ${String(r.session).slice(0, 8)} (${short(r.cwd ?? "")}) :: ${one(String(r.detail ?? ""), 200)}`,
      { ts: r.ts, sid: String(r.session).slice(0, 8), project: r.cwd ?? "", text: String(r.detail ?? ""), regex: true, jev: null });
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
  type GapItem = { skill: string; row: Row; tag: Tag; score: number | undefined; settled: boolean; audit: boolean };
  const perSkill: { skill: string; hits: Row[]; gaps: Row[]; predates: number; m?: Merged; items: GapItem[]; score: (r: Row) => number | undefined }[] = [];
  for (const [skill, re] of Object.entries(SKILL_KEYWORDS)) {
    const since = SKILL_SINCE[skill];
    const names = [skill, ...(SKILL_ALIASES[skill] ?? [])];
    const loaded = (r: Row) => names.some((n) => loadedIn(r.sid, n));
    const eligible = since ? hand.filter((r) => r.ts >= since) : hand;
    const predates = since ? hand.filter((r) => r.ts < since && re.test(r.text) && !loaded(r)).length : 0;
    const hits = eligible.filter((r) => re.test(r.text));
    const gaps = hits.filter((r) => !loaded(r));
    const score = (r: Row) => (V?.get(r)?.skill === skill ? V.get(r)!.skillConf : undefined);
    if (V) {
      const m = merge(gaps, eligible.filter((r) => !loaded(r)), score, Math.min(cap, 6), act);
      const items = m.brief.map(({ row, tag }) => ({ skill, row, tag, score: score(row), settled: !opts.verifyAll && (score(row) ?? 0) >= act, audit: false }));
      perSkill.push({ skill, hits, gaps, predates, m, items, score });
    } else perSkill.push({ skill, hits, gaps, predates, items: gaps.slice(0, Math.min(cap, 6)).map((row) => ({ skill, row, tag: { kind: null }, score: undefined, settled: false, audit: false })), score });
  }
  // Settled items stay out of the briefs, except the audit sample that keeps top-band labels coming.
  perSkill.flatMap((p) => p.items).filter((it) => it.settled).forEach((it, i) => { it.audit = isAudit(i); });
  for (const { skill, hits, gaps, predates, m, items, score } of perSkill) {
    const pre = predates ? ` (${predates} older than the skill, ${SKILL_SINCE[skill]}, dropped)` : "";
    if (m) {
      if (!hits.length && !m.brief.length && !predates) continue;
      out.push(`- ${skill}: ${gaps.length} gap / ${hits.length} hit${pre}`);
      out.push(`    gaps: ${m.line}`);
      examples(m, "    ", (r) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 90)}`);
      const done = items.filter((it) => it.settled);
      if (done.length) {
        out.push(`    settled by jev: ${done.length} (${done.filter((it) => it.audit).length} audited in the brief)`);
        for (const it of done.slice(0, cap)) out.push(`      ${it.row.ts.slice(0, 16)} ${short(it.row.project)} ${it.row.sid} jev ${it.score!.toFixed(2)}${it.audit ? " audit" : ""} :: ${one(it.row.text, 90)}`);
      }
    } else {
      if (!hits.length && !predates) continue;
      out.push(`- ${skill}: ${gaps.length} gap / ${hits.length} hit${pre}`);
      for (const { row: r } of items) out.push(`    ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 90)}`);
    }
    for (const it of items) {
      const r = it.row, inRegex = it.tag.kind === "both" || it.tag.kind === "regex" || !m;
      const p = V ? (V.has(r) ? it.score ?? 0 : null) : null;
      const rec = recOf(r, inRegex, p, { skill, ...(it.settled ? { settled: true } : {}) });
      if (it.settled && !it.audit) { settled.push({ bucket: "gaps", ...rec }); continue; }
      const tag = it.audit ? { ...it.tag, audit: it.score } : it.tag;
      add("gaps", `- [${skill}] ${m ? fmtTags([tag]) + " " : ""}${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 160)}`, rec);
    }
  }

  // Corrections
  const corrections = hand.filter((r) => CORRECTION_RE.test(r.text));
  out.push(`\n## Correction openers: ${corrections.length}`);
  if (V) {
    const score = (r: Row) => V.get(r)?.correction;
    const m = merge(corrections, hand, score, cap * 2, act);
    const fmt = (r: Row) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 140)}`;
    out.push(m.line);
    for (const r of m.both.slice(0, cap)) out.push(`- (both) ${fmt(r)}`);
    examples(m, "", fmt);
    for (const { row: r, tag } of m.brief) add("corrections", `- ${fmtTags([tag])} ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 200)}`, recOf(r, tag.kind === "both" || tag.kind === "regex", V.has(r) ? score(r)! : null));
  } else for (const r of corrections.slice(0, cap * 2)) {
    out.push(`- ${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid} :: ${one(r.text, 140)}`);
    add("corrections", `- ${r.ts.slice(0, 16)} ${r.sid} (${short(r.project)}) :: ${one(r.text, 200)}`, recOf(r, true, null));
  }

  // Nudges
  const answers = hand.filter((r) => isAnswer(r.prev));
  const isAns = new Set(answers);
  const nudges = hand.filter((r) => NUDGE_RE.test(r.text) && !isAns.has(r));
  const answersExcluded = answers.filter((r) => NUDGE_RE.test(r.text)).length;
  out.push(`\n## Nudges: ${nudges.length}, ${answersExcluded} answers excluded (verify the cause per session: \`chatlog show <sid> --grep "529|limit|Overloaded"\`)`);
  const nudgeBySid = counter(nudges.map((r) => `${short(r.project)} ${r.sid}`));
  if (V) {
    // Sessions: the regex scan's top `cap` plus the top `cap` by Jev-only rows; each lists all its union rows.
    const score = (r: Row) => V.get(r)?.nudge;
    const m = merge(nudges, hand.filter((r) => !isAns.has(r)), score, Infinity, act);
    out.push(m.line);
    examples(m, "", (r) => `${r.ts.slice(0, 16)} ${short(r.project)} ${r.sid}${score(r) === undefined ? "" : ` jev ${score(r)!.toFixed(2)}`} :: ${one(r.text, 60)}`);
    const inRegex = new Set(nudges);
    const top = (rs: Row[]) => sorted(counter(rs.map((r) => r.sid))).slice(0, cap).map(([sid]) => sid);
    const sids = new Set([...top(nudges), ...top(m.brief.map((p) => p.row).filter((r) => !inRegex.has(r)))]);
    const sessions = [...sids].map((sid) => m.brief.filter((p) => p.row.sid === sid)).sort((a, b) => b.length - a.length);
    for (const ps of sessions) {
      const r0 = ps[0].row, tags = fmtTags(ps.map((p) => p.tag));
      out.push(`- ${ps.length}× ${short(r0.project)} ${r0.sid} ${tags}`);
      add("nudges", `- ${tags} ${r0.sid} (${short(r0.project)}) ${ps.length}× at ${ps.map((p) => p.row.ts.slice(11, 16)).slice(0, 6).join(", ")}`,
        recOf(r0, ps.some((p) => p.tag.kind === "both" || p.tag.kind === "regex"), Math.max(...ps.map((p) => score(p.row) ?? 0))));
    }
  } else for (const [k, v] of sorted(nudgeBySid).slice(0, cap)) {
    out.push(`- ${v}× ${k}`);
    const sid = k.split(" ")[1];
    const at = nudges.filter((r) => r.sid === sid).map((r) => r.ts.slice(11, 16)).slice(0, 6).join(", ");
    add("nudges", `- ${sid} (${k.split(" ")[0]}) ${v}× at ${at}`, recOf(nudges.find((r) => r.sid === sid)!, true, null));
  }

  // Repeats
  out.push("\n## Repeated prompts");
  const exact = counter(hand.map((r) => norm(r.text).join(" ")).filter((s) => s.length > 2));
  for (const [k, v] of sorted(exact).filter(([, v]) => v >= 2).slice(0, cap)) {
    out.push(`- ${v}× exact: ${one(k, 90)}`);
    if (NUDGE_RE.test(k)) continue; // a repeated nudge is the nudges bucket's item, not re-done work
    const sids = [...new Set(hand.filter((r) => norm(r.text).join(" ") === k).map((r) => r.sid))];
    add("repeats", `- ${v}× exact "${one(k, 90)}" in ${sids.slice(0, 4).join(", ")}`, { ts: "", sid: sids[0], project: "", text: k, regex: true, jev: null });
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
    add("repeats", `- ${rs.length}× "${k}…" in ${[...new Set(rs.map((r) => r.sid))].slice(0, 4).join(", ")} :: e.g. ${one(rs[0].text, 120)}`, recOf(rs[0], true, null, { text: k }));
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
  return { text: out.join("\n"), briefs, recs, settled };
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
    const long = "Translation 50-min check. Log: /tmp/x. Read the log, compare against the goal, report what changed and schedule the next check unless the goal is met.";
    const echoRows: Row[] = [1, 2, 3].map((i) => ({ ts: `2026-09-01T0${i}:00`, project: "-Users-x-proj", sid: "s2", text: long }));
    const echo = dropAutomationEchoes([...rows, ...echoRows, { ts: "2026-09-01T04:00", project: "-Users-x-proj", sid: "s3", text: long }]);
    console.assert(echo.dropped === 2 && echo.rows.length === rows.length + 2, `dropAutomationEchoes ${echo.dropped}/${echo.rows.length}`);
    const tick = (w: string) => `Check on the five PR rebase agents (see the list in the last status block) and integrate whatever finished into the stack, then report which branches are still red${w}`;
    const near = dropAutomationEchoes([1, 2, 3].map((i) => ({ ts: `2026-09-01T0${i}:00`, project: "-Users-x-proj", sid: "s4", text: tick(["", " now", ", thanks."][i - 1]) })));
    console.assert(near.dropped === 2 && near.rows.length === 1, `near-duplicate echoes ${near.dropped}/${near.rows.length}`);
    const poll = "Check on the five PR rebase agents (pr1368, pr1358, pr1380, pr1330, pr1331) and integrate whatever finished";
    const short3 = dropAutomationEchoes([1, 2, 3].flatMap((i) => [{ ts: `2026-09-01T0${i}:00`, project: "-Users-x-proj", sid: "s5", text: poll }, { ts: `2026-09-01T0${i}:30`, project: "-Users-x-proj", sid: "s5", text: "continue" }]));
    console.assert(short3.dropped === 2 && short3.rows.filter((r) => r.text === "continue").length === 3, `short poll echoes ${short3.dropped}`);
    const ex = excludeSessions([{ ts: "2026-09-01T00:00", project: "p", sid: "ea447cfe", text: "a" }, { ts: "2026-09-01T00:01", project: "p", sid: "ea447cfe", text: "[skill:retro]", agent: true }, { ts: "2026-09-01T00:02", project: "p", sid: "b1", text: "b" }], "ea447c, zz");
    console.assert(ex.dropped === 2 && ex.sessions === 1 && ex.rows.length === 1 && excludeSessions(ex.rows, "").dropped === 0, `excludeSessions ${ex.dropped}/${ex.sessions}`);
    const aliasRep = report([
      { ts: "2026-09-10T00:00", project: "-Users-x-proj", sid: "al1", text: "[skill:rebase-babysit]" },
      { ts: "2026-09-10T00:01", project: "-Users-x-proj", sid: "al1", text: "rebase the branch and force push" },
      { ts: "2026-09-10T00:02", project: "-Users-x-proj", sid: "al2", text: "verify states, it seems stuck" },
      { ts: "2026-09-20T00:02", project: "-Users-x-proj", sid: "al3", text: "verify states, it seems stuck" },
    ], 30, 5, "/nonexistent").text;
    console.assert(aliasRep.includes("- rebase-pr: 0 gap / 1 hit") && aliasRep.includes("- agent-status: 1 gap / 1 hit (1 older than the skill, 2026-09-16, dropped)"), `aliases and since: ${aliasRep.split("\n").filter((l) => /rebase-pr|agent-status/.test(l)).join(" | ")}`);
    console.assert(isAnswer("Force-push the branch?") && isAnswer("Pick one:\n1. rebase\n2. merge") && isAnswer("Want me to apply it") && isAnswer("- a\n- b") === true, "isAnswer positives");
    console.assert(!isAnswer("API Error: 529 Overloaded") && !isAnswer("Usage limit reached, resets at 5pm") && !isAnswer("Sleeping 270s until the next check.") && !isAnswer("Done. All checks pass.") && !isAnswer(undefined), "isAnswer negatives");
    const nrep = report([
      { ts: "2026-09-01T00:00", project: "-Users-x-proj", sid: "n1", text: "yes", prev: "Force-push the branch?" },
      { ts: "2026-09-01T00:01", project: "-Users-x-proj", sid: "n2", text: "resume", prev: "API Error: 529 Overloaded" },
    ], 30, 5, "/nonexistent").text;
    console.assert(nrep.includes("## Nudges: 1, 1 answers excluded"), "nudges answers excluded");
    console.assert(SKILL_KEYWORDS["perf-"].test("benchmark fix-point on two machines") && SKILL_KEYWORDS["perf-"].test("replace the async runtime and benchmark latency against tokio") && SKILL_KEYWORDS["perf-"].test("propose an implementation plan that reduce hot path latency") && !SKILL_KEYWORDS["perf-"].test("verify slow github CI") && !SKILL_KEYWORDS["perf-"].test("speed up shell startup scripts") && !SKILL_KEYWORDS["perf-"].test("save storage"), "perf keywords");
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
    // Settling: five gap items Jev is sure of (index 0 audited), one in the verify band; verifyAll keeps all.
    const gapRows = parsePrompts([
      ...[0, 1, 2, 3, 4].map((i) => `[2026-09-02T00:0${i} -Users-x-p g] babysit pr ${i}`),
      "[2026-09-02T00:06 -Users-x-p g] babysit",
      "  ^prev: PR 12 is open, CI running",
    ].join("\n"));
    console.assert(gapRows[5].prev === "PR 12 is open, CI running" && gapRows[5].text === "babysit", "parsePrompts prev");
    const seen: any[] = [];
    const ask2: AskFn = async (state) => {
      seen.push(state);
      const babysit = (state as { prompt: string }).prompt === "babysit";
      return { answers: { is_correction: { noul: 0.1 }, is_nudge: { noul: 0.1 }, wanted_skill: { choice: "babysit-pr", confidence: babysit ? 0.6 : 0.95 } }, usage: { input_tokens: 1 }, model: "jev-test" };
    };
    const run2 = await jevClassify(handRows(gapRows), ask2);
    console.assert(seen.filter((x) => x.previous_reply).length === 1 && run2.model === "jev-test" && run2.status.includes("model jev-test"), "previous_reply and model");
    const r2 = report(gapRows, 30, 10, "/nonexistent", run2);
    console.assert(r2.settled.length === 4 && r2.settled.every((x) => x.settled && x.jev === 0.95), `settled ${r2.settled.length}`);
    console.assert(r2.briefs.gaps.length === 2 && r2.briefs.gaps[0].includes("(jev 0.95, audit)") && r2.briefs.gaps[1].includes("(regex) (jev 0.60, verify)"), `settled briefs ${r2.briefs.gaps}`);
    console.assert(r2.text.includes("settled by jev: 5 (1 audited") && r2.recs.gaps[1].jev === 0.6 && r2.recs.gaps[1].regex, "settled line and recs");
    const r3 = report(gapRows, 30, 10, "/nonexistent", run2, { verifyAll: true });
    console.assert(r3.settled.length === 0 && r3.briefs.gaps.length === 6 && r3.recs.gaps.length === 6, "verifyAll");
    console.log("selfcheck ok");
  } else {
    const days = Number(arg("days", "30"));
    const cap = Number(arg("cap", "12"));
    const ledger = arg("ledger", join(homedir(), ".claude/rules-engine-state/audit.jsonl"));
    let dump: string;
    const file = arg("prompts", "");
    if (file) dump = readFileSync(file, "utf8");
    else {
      const cmd = ["bun", findChatlog(), "prompts", "--days", String(days), "--include-agents", "--width", "0", "--prev"];
      const project = arg("project", "");
      if (project) cmd.push("--project", project);
      const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
      if (proc.exitCode !== 0) process.exit(proc.exitCode);
      dump = proc.stdout.toString();
    }
    const excl = excludeSessions(parsePrompts(dump), arg("exclude", ""));
    if (excl.dropped) console.error(`excluded ${excl.dropped} rows from ${excl.sessions} sessions (--exclude)`);
    const echo = dropAutomationEchoes(excl.rows);
    const rows = echo.rows;
    if (echo.dropped) console.error(`dropped ${echo.dropped} automation echoes (same long prompt prefix >= ${ECHO_MIN_REPEATS}x in one session)`);
    const act = Number(arg("jev-act", String(JEV_ACT)));
    let jev: JevRun = { status: "jev: off (--no-jev), regex only", verdicts: null, inputTokens: 0 };
    if (!has("no-jev")) {
      const j = await loadJev();
      if ("reason" in j) jev = { status: `jev: unavailable (${j.reason}), regex only`, verdicts: null, inputTokens: 0 };
      else {
        const hand = handRows(rows);
        console.error(`jev: classifying ${hand.length} hand-typed prompts, 8 in flight`);
        jev = await jevClassify(hand, j.ask, 8, act);
      }
    }
    const { text, briefs, recs, settled } = report(rows, days, cap, ledger, jev, { act, verifyAll: has("verify-all") });
    console.log(text);
    const dir = arg("briefs", "");
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      const per = Number(arg("per-brief", "24"));
      const sidecar: object[] = [];
      const model = jev.model ?? null;
      for (const [bucket, items] of Object.entries(briefs) as [Bucket, string[]][]) {
        if (!items.length) continue;
        const parts = items.length > per ? Math.ceil(items.length / per) : 1;
        for (let i = 0; i < parts; i++) {
          const part = parts > 1 ? `-${i + 1}` : "";
          const chunk = items.slice(i * per, (i + 1) * per);
          const path = join(dir, `brief-${bucket}${part}.md`);
          writeFileSync(path, renderBrief(bucket, chunk, days, findChatlog(), resolve(dir), part));
          written.push(`${path} (${chunk.length} items)`);
          recs[bucket].slice(i * per, (i + 1) * per).forEach((rec, j) => sidecar.push({ file: `brief-${bucket}${part}.md`, index: j, ...rec, jev_model: model }));
        }
      }
      for (const rec of settled) sidecar.push({ file: null, index: null, ...rec, jev_model: model });
      writeFileSync(join(dir, "items.jsonl"), sidecar.map((x) => JSON.stringify(x)).join("\n") + (sidecar.length ? "\n" : ""));
      console.error(written.length ? `briefs written:\n  ${written.join("\n  ")}` : "briefs: no items in any bucket");
    }
  }
}
