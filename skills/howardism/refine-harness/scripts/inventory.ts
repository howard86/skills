#!/usr/bin/env bun
/**
 * refine-harness inventory — one read-only pass that prints every always-on surface's
 * facts, the evidence tallies, the cost ledger and per-rule compliance rates.
 *
 *   bun inventory.ts [--days N] [--baseline] [--include-harness]
 *
 *   --days N           evidence window (default 30; transcripts are pruned at ~30d)
 *   --baseline         append this run's headline numbers to ~/claude/harness-baselines.jsonl
 *                      (every run prints deltas against the last line of that file)
 *   --include-harness  keep eval/probe projects (-private-tmp-*, bare home cwd) in the scan
 *
 * Sources: ~/.claude/CLAUDE.md symlink → config repo ($AP), $AP/claude/settings.json,
 * $AP/rules-engine/rules, ~/.claude/rules-engine-state/audit.jsonl, ~/.claude/projects/
 * (memory dirs, session transcripts and their subagents/ transcripts modified inside the
 * window), ~/.claude/skills, ~/.codex/AGENTS.md, $AP/cursor/USER_RULES.md, GUIDANCE.md.
 * Writes nothing except the baseline line when asked. Exit 0; a missing source is reported
 * inline, never thrown.
 *
 * Exact token costs need a live probe: `bun ablate.ts measure` (see that script).
 */

import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const DAYS = Number(args[args.indexOf("--days") + 1]) || 30;
const NOW = Date.now();
const SINCE = NOW - DAYS * 86_400_000;
const SKILL_DIR = dirname(import.meta.dir);
const BASELINES = join(HOME, "claude", "harness-baselines.jsonl");
const HOME_SLUG = "-" + HOME.replace(/^\//, "").replace(/\//g, "-");
const isHarnessProject = (slug: string) => slug.startsWith("-private-tmp-") || slug === HOME_SLUG;

const out: string[] = [];
const p = (s = "") => out.push(s);
const h = (s: string) => p(`\n## ${s}`);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const linkTarget = (f: string) => {
  try { return lstatSync(f).isSymbolicLink() ? readlinkSync(f) : null; } catch { return null; }
};
const tok = (bytes: number) => Math.round(bytes / 4);
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const pct = (num: number, den: number) => (den ? `${Math.round((100 * num) / den)}%` : "-");

// ---------------------------------------------------------------- resolve
const claudeMd = join(HOME, ".claude", "CLAUDE.md");
const claudeMdTarget = linkTarget(claudeMd);
const AP = claudeMdTarget?.endsWith("/claude/CLAUDE.md") ? dirname(dirname(claudeMdTarget)) : null;
const settingsPath = join(HOME, ".claude", "settings.json");
const settingsTarget = linkTarget(settingsPath);
let settings: any = {};
try { settings = JSON.parse(read(settingsPath) ?? "{}"); } catch { settings = { _parseError: true }; }

let version = "unknown";
try {
  const v = Bun.spawnSync({ cmd: ["claude", "--version"] }).stdout.toString().trim();
  version = v.split(/\s+/)[0] || "unknown";
} catch { /* claude not on PATH */ }

let guidanceLine = "GUIDANCE.md: missing";
{
  const g = read(join(SKILL_DIR, "GUIDANCE.md"));
  const checked = g?.match(/^checked:\s*(\S+)/m)?.[1];
  const gver = g?.match(/^claude-code:\s*(\S+)/m)?.[1];
  if (checked) {
    const age = Math.floor((NOW - Date.parse(checked)) / 86_400_000);
    const cmp = (a: string, b: string) => {
      const x = a.split(".").map(Number), y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    };
    const stale = age > 30 || (gver && version !== "unknown" && cmp(version, gver) > 0);
    guidanceLine = `GUIDANCE.md: checked ${checked} (${age}d ago) against ${gver ?? "?"} → ${stale ? "STALE, refresh first" : "current"}`;
  }
}

p(`# refine-harness inventory  ${new Date().toISOString().slice(0, 10)}  claude ${version}  model=${settings.model ?? "?"}  effort=${settings.effortLevel ?? "?"}  window=${DAYS}d`);
p(`AP=${AP ?? "UNRESOLVED (~/.claude/CLAUDE.md is not a symlink into <repo>/claude/)"}`);
p(`settings.json → ${settingsTarget ?? "REAL FILE (symlink clobbered? see link.sh --capture)"}`);
p(guidanceLine);

// ---------------------------------------------------------------- audit log
const auditPath = join(HOME, ".claude", "rules-engine-state", "audit.jsonl");
type Row = { ts: string; session: string; event: string; rule: string; action: string; detail?: string; agent?: string };
const rows: Row[] = [];
for (const l of (read(auditPath) ?? "").split("\n")) {
  if (!l) continue;
  try { const r = JSON.parse(l); if (Date.parse(r.ts) >= SINCE) rows.push(r); } catch { /* skip */ }
}
const sessionsStarted = new Set(rows.filter((r) => r.rule === "session-start").map((r) => r.session)).size;
const firesBySession = new Map<string, Row[]>();
for (const r of rows) {
  if (r.action === "state") continue;
  (firesBySession.get(r.session) ?? firesBySession.set(r.session, []).get(r.session)!).push(r);
}

// ---------------------------------------------------------------- transcripts (one pass)
type Ev = { t: number; kind: "tool" | "user"; name: string; cmd: string; bg: boolean; sandboxOff: boolean; model: string; sub: string; cwd: string; agent: string };
const projectsDir = join(HOME, ".claude", "projects");
const memReads = new Map<string, Set<string>>();
const skillUse = new Map<string, Set<string>>();
const corrections: { sess: string; proj: string; text: string }[] = [];
const timelines = new Map<string, Ev[]>(); // 8-char session prefix → ordered events (main + subagents)
let typedPrompts = 0, scannedFiles = 0, scannedBytes = 0, skippedHarness = 0;
const CORRECTION_START = /^(no[,.!:\s]|nope\b|wrong\b|not that\b|not what\b|don'?t\b|do not\b|stop\b|again\b|actually\b|undo\b|revert\b|that'?s not\b|still\b|instead\b)/i;
const CORRECTION_ANY = /\b(i said|i told you|i asked for|not what i|you ignored|you missed|you skipped|why did(n'?t)? you|should have|as i said|i meant|i already|didn'?t ask)\b/i;
const isCorrection = (t: string) => CORRECTION_START.test(t.trim()) || CORRECTION_ANY.test(t.slice(0, 200));
const memRe = /\/\.claude\/projects\/[^"\s\\]+\/memory\/[^"\s\\]+\.md/g;
const skillRe = /Base directory for this skill: (.+?)(?=\\n|"|$)/g;

function scanFile(fp: string, proj: string, sess: string, isAgent: boolean) {
  let st; try { st = statSync(fp); } catch { return; }
  if (st.mtimeMs < SINCE || !st.isFile()) return;
  scannedFiles++; scannedBytes += st.size;
  const wantTimeline = firesBySession.has(sess);
  const text = readFileSync(fp, "utf8");
  for (const line of text.split("\n")) {
    if (line.includes("/memory/")) {
      for (const m of line.matchAll(memRe)) {
        const key = m[0].replace(/^.*\/\.claude\/projects\//, "");
        (memReads.get(key) ?? memReads.set(key, new Set()).get(key)!).add(sess);
      }
    }
    if (line.includes("Base directory for this skill:")) {
      for (const m of line.matchAll(skillRe)) {
        const path = m[1]!.trim();
        if (!path.includes("/skills/")) continue;
        const name = basename(path);
        if (!/^[\w.-]+$/.test(name) || name.endsWith(".jsonl")) continue;
        (skillUse.get(name) ?? skillUse.set(name, new Set()).get(name)!).add(sess);
      }
    }
    if (!line.startsWith("{")) continue;
    const isUser = line.includes('"type":"user"');
    const isTool = line.includes('"tool_use"') && line.includes('"type":"assistant"');
    if (!isUser && !isTool) continue;
    if (isUser && line.includes('"isMeta":true')) continue;
    if (!isUser && !wantTimeline) continue;
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    const t = Date.parse(obj.timestamp ?? "") || 0;
    const agent = String(obj.agentId ?? "").slice(0, 8);
    if (isUser) {
      const c = obj?.message?.content;
      const txt: string | undefined = typeof c === "string" ? c : Array.isArray(c) ? c.find((x: any) => x?.type === "text")?.text : undefined;
      const hasToolResult = Array.isArray(c) && c.some((x: any) => x?.type === "tool_result");
      if (hasToolResult) continue;
      if (!txt || txt.startsWith("<") || txt.startsWith("Base directory") || txt.startsWith("[Request interrupted") || txt.startsWith("Stop hook")) continue;
      if (isAgent || obj.isSidechain) continue; // agent-authored briefs are not typed prompts
      typedPrompts++;
      if (wantTimeline) (timelines.get(sess) ?? timelines.set(sess, []).get(sess)!).push({ t, kind: "user", name: "", cmd: txt.slice(0, 120), bg: false, sandboxOff: false, model: "", sub: "", cwd: obj.cwd ?? "", agent });
      if (isCorrection(txt)) corrections.push({ sess, proj: proj.replace(new RegExp("^" + HOME_SLUG + "-"), ""), text: txt.replace(/\s+/g, " ") });
      continue;
    }
    for (const b of obj?.message?.content ?? []) {
      if (b?.type !== "tool_use") continue;
      const inp = b.input ?? {};
      (timelines.get(sess) ?? timelines.set(sess, []).get(sess)!).push({
        t, kind: "tool", name: String(b.name ?? ""), cmd: String(inp.command ?? inp.skill ?? inp.file_path ?? "").slice(0, 400),
        bg: inp.run_in_background === true, sandboxOff: inp.dangerouslyDisableSandbox === true,
        model: String(inp.model ?? ""), sub: String(inp.subagent_type ?? ""), cwd: String(obj.cwd ?? ""), agent,
      });
    }
  }
}

if (existsSync(projectsDir)) {
  for (const proj of readdirSync(projectsDir)) {
    if (!flag("--include-harness") && isHarnessProject(proj)) { skippedHarness++; continue; }
    const pd = join(projectsDir, proj);
    let entries: string[] = [];
    try { entries = readdirSync(pd); } catch { continue; }
    for (const f of entries) {
      const fp = join(pd, f);
      if (f.endsWith(".jsonl")) { scanFile(fp, proj, f.slice(0, 8), false); continue; }
      const sub = join(fp, "subagents");
      if (!existsSync(sub)) continue;
      for (const a of readdirSync(sub)) if (a.endsWith(".jsonl")) scanFile(join(sub, a), proj, f.slice(0, 8), true);
    }
  }
}
for (const evs of timelines.values()) evs.sort((a, b) => a.t - b.t);
p(`transcripts scanned: ${scannedFiles} files, ${(scannedBytes / 1048576).toFixed(0)} MB, ${typedPrompts} typed prompts (heuristic filter); harness projects skipped: ${skippedHarness}`);

// ---------------------------------------------------------------- claude-md + mirrors
h("claude-md");
const cm = read(claudeMd);
const cmLines = cm ? cm.split("\n").length : 0;
if (cm) {
  const lines = cm.split("\n");
  const bullets = lines.filter((l) => /^\s*[-*]\s/.test(l));
  const emphasis = lines.filter((l) => /\b(IMPORTANT|NEVER|ALWAYS|MUST)\b/.test(l)).length;
  const bold = lines.filter((l) => /\*\*[^*]+\*\*/.test(l)).length;
  const negations = lines.filter((l) => /\b(don'?t|never|do not|avoid)\b/i.test(l)).length;
  p(`${claudeMd} → ${claudeMdTarget ?? "REAL FILE"}`);
  p(`${lines.length} lines  ${cm.length} B  ~${tok(cm.length)} tok (estimate; \`bun ablate.ts measure\` for exact)  headers=${lines.filter((l) => l.startsWith("#")).length}  bullets=${bullets.length}  caps-emphasis=${emphasis}  bold-lines=${bold}  negation-lines=${negations}`);
  const norm = (s: string) => s.toLowerCase().replace(/[`*_"'.,;:()—-]/g, " ").replace(/\s+/g, " ").trim();
  const mine = new Set(bullets.map(norm));
  const mirror = (label: string, path: string) => {
    const t = read(path);
    if (!t) return p(`${label}: ${path} missing`);
    const mb = t.split("\n").filter((l) => /^\s*[-*]\s/.test(l));
    const shared = mb.filter((l) => mine.has(norm(l))).length;
    p(`${label}: ${t.split("\n").length} lines, ${mb.length} bullets, ${shared} verbatim-shared with CLAUDE.md, ${mb.length - shared} mirror-only`);
  };
  mirror("codex  ~/.codex/AGENTS.md", join(HOME, ".codex", "AGENTS.md"));
  if (AP) mirror("cursor $AP/cursor/USER_RULES.md", join(AP, "cursor", "USER_RULES.md"));
} else p("missing");

// ---------------------------------------------------------------- rules
h(`rules  ${AP ? `$AP/rules-engine/rules` : "(no AP)"}  audit rows in window: ${rows.length}, sessions started: ${sessionsStarted}`);
const ruleFiles = new Map<string, Record<string, string>>();
if (AP) {
  const rd = join(AP, "rules-engine", "rules");
  for (const f of existsSync(rd) ? readdirSync(rd).sort() : []) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(rd, f), "utf8");
    const fm: Record<string, string> = {};
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    for (const line of (m?.[1] ?? "").split("\n")) {
      const i = line.indexOf(":"); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    fm._body = String((m?.[2] ?? "").trim().length);
    ruleFiles.set(fm.id ?? f.replace(/\.md$/, ""), fm);
  }
}
const byRule = new Map<string, { fires: number; sessions: Set<string>; actions: Map<string, number>; last: string; details: string[] }>();
for (const r of rows) {
  if (r.action === "state") continue;
  const e = byRule.get(r.rule) ?? { fires: 0, sessions: new Set(), actions: new Map(), last: "", details: [] };
  e.fires++; e.sessions.add(r.session); bump(e.actions, r.action); if (r.ts > e.last) e.last = r.ts;
  if (r.detail && e.details.length < 3) e.details.push(r.detail.replace(/\s+/g, " "));
  byRule.set(r.rule, e);
}
const META = new Set(["tool-failure", "permission-denied", "engine-error", "lock-timeout", "symlink-check", "subagent-start", "subagent-stop", "reset-seen"]);
let injectedBytesPerSession = 0;
p(pad("id", 26) + pad("event", 17) + pad("action", 8) + pad("gate", 12) + rpad("fires", 6) + rpad("sess", 6) + rpad("/sess", 7) + "  last        text-B");
for (const [id, fm] of ruleFiles) {
  const e = byRule.get(id);
  const gate = fm.once === "session" ? "once" : fm.every ? `every:${fm.every}` : fm.special ? "special" : "-";
  const perSess = sessionsStarted ? (e?.fires ?? 0) / sessionsStarted : 0;
  if ((fm.action ?? "inject") === "inject") injectedBytesPerSession += perSess * Number(fm._body);
  p(pad(id, 26) + pad(fm.event ?? "?", 17) + pad(fm.action ?? "inject", 8) + pad(gate, 12) + rpad(e?.fires ?? 0, 6) + rpad(e?.sessions.size ?? 0, 6) + rpad(sessionsStarted ? ((e?.sessions.size ?? 0) / sessionsStarted).toFixed(2) : "-", 7) + "  " + (e?.last.slice(0, 10) ?? "never     ") + "  " + fm._body);
}
const retired = [...byRule.keys()].filter((k) => !ruleFiles.has(k) && !META.has(k));
if (retired.length) p(`audit ids with no rule file (retired, history only): ${retired.map((k) => `${k}×${byRule.get(k)!.fires}`).join(", ")}`);
const samples = [...byRule.entries()].filter(([k, e]) => ruleFiles.has(k) && (e.actions.get("deny") || e.actions.get("ask")));
if (samples.length) {
  p("deny/ask samples (false-positive check):");
  for (const [k, e] of samples) for (const d of e.details) p(`  ${pad(k, 18)} ${trunc(d, 110)}`);
}
for (const k of ["engine-error", "lock-timeout", "symlink-check"]) {
  const e = byRule.get(k); if (e) p(`${k}: ${e.fires} (${e.sessions.size} sessions) e.g. ${trunc(e.details[0] ?? "", 100)}`);
}

// ---------------------------------------------------------------- compliance (tier 2)
h("compliance  (per rule: did behaviour follow the injection? predicates over audit + transcript timelines; heuristics — open non-compliant sessions with chatlog.ts show)");
type Verdict = boolean | null; // null = not evaluable
const LONG_JOB = /\b(while|until)\b[\s\S]*\bsleep\s+[1-9][0-9]+\b|\bsleep\s+([6-9][0-9]|[1-9][0-9]{2,})\b/;
const after = (evs: Ev[], t0: number, agent: string, sameAgent = false) => evs.filter((e) => e.t > t0 && (!sameAgent || e.agent === agent));
const tools = (evs: Ev[]) => evs.filter((e) => e.kind === "tool");
const bash = (evs: Ev[]) => evs.filter((e) => e.kind === "tool" && e.name === "Bash");
const agents = (evs: Ev[]) => evs.filter((e) => e.kind === "tool" && e.name === "Agent");
const CODEGRAPH = { what: "a codegraph tool or CLI call follows", eval: (evs: Ev[], f: Row): Verdict => { const a = tools(after(evs, Date.parse(f.ts), f.agent ?? "")); if (!a.length) return null; return a.some((e) => e.name.startsWith("mcp__codegraph__") || (e.name === "Bash" && /\bcodegraph\s/.test(e.cmd))); } };
function sandboxVerdict(evs: Ev[], f: Row): Verdict {
  const a = bash(after(evs, Date.parse(f.ts), f.agent ?? "", true)).filter((e) => /\/\.claude\/worktrees\//.test(e.cwd) && /^\s*(git|cargo)\b/.test(e.cmd));
  if (!a.length) return null;
  return a.every((e) => e.sandboxOff);
}
const SANDBOX = { what: "later git/cargo in a worktree cwd disable the sandbox", eval: sandboxVerdict };
const PREDICATES: Record<string, { what: string; eval: (evs: Ev[], fire: Row) => Verdict }> = {
  "ci-blocking-wait": {
    what: "a blocking wait follows: `gh run watch` or a backgrounded gh command",
    eval: (evs, f) => { const a = bash(after(evs, Date.parse(f.ts), f.agent ?? "")); if (!a.some((e) => /\bgh\b/.test(e.cmd))) return null; return a.some((e) => /\bgh\s+run\s+watch\b/.test(e.cmd) || (e.bg && /\bgh\b/.test(e.cmd))); },
  },
  "long-jobs": {
    what: "later long sleeps/loops run in the background or via Monitor",
    eval: (evs, f) => { const a = after(evs, Date.parse(f.ts), f.agent ?? ""); const lj = bash(a).filter((e) => LONG_JOB.test(e.cmd)); if (!lj.length && !a.some((e) => e.name === "Monitor")) return null; return lj.every((e) => e.bg) || a.some((e) => e.name === "Monitor"); },
  },
  "agent-model": {
    what: "the retried spawn carries an explicit model",
    eval: (evs, f) => { const n = agents(after(evs, Date.parse(f.ts), f.agent ?? ""))[0]; return n ? n.model !== "" : null; },
  },
  "agent-fanout": {
    what: "no further spawn before a user turn or an AskUserQuestion",
    eval: (evs, f) => { const a = after(evs, Date.parse(f.ts), f.agent ?? ""); const stop = a.findIndex((e) => e.kind === "user" || e.name === "AskUserQuestion"); const span = stop === -1 ? a : a.slice(0, stop); return !span.some((e) => e.name === "Agent"); },
  },
  "stop-commit": {
    what: "a git commit or a committer spawn follows the block",
    eval: (evs, f) => { const a = after(evs, Date.parse(f.ts), f.agent ?? ""); return a.some((e) => (e.name === "Bash" && /\bgit\s+commit\b/.test(e.cmd)) || (e.name === "Agent" && /committer/.test(e.sub)) || (e.name === "Skill" && /commit-and-pr/.test(e.cmd))); },
  },
  "stop-pr": { what: "a subagent spawn follows the block", eval: (evs, f) => agents(after(evs, Date.parse(f.ts), f.agent ?? "")).length > 0 },
  "pr-followthrough": { what: "a babysitter spawn follows the PR", eval: (evs, f) => agents(after(evs, Date.parse(f.ts), "")).length > 0 },
  "workflow-apply": {
    what: "an implementer spawn follows, or fewer than five inline writes",
    eval: (evs, f) => { const a = after(evs, Date.parse(f.ts), ""); const writes = tools(a).filter((e) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(e.name)).length; if (agents(a).some((e) => /implement|sonnet|general-purpose/.test(e.sub))) return true; return writes < 5; },
  },
  "apply-inline-edits": { what: "a spawn follows the reminder", eval: (evs, f) => agents(after(evs, Date.parse(f.ts), "")).length > 0 },
  "fix-verify": {
    what: "a test or reproduction command runs later in the session",
    eval: (evs, f) => { const a = bash(after(evs, Date.parse(f.ts), "")); if (!a.length) return null; return a.some((e) => /\b(cargo\s+(test|nextest|run)|bun\s+(test|run\s+(test|check))|npm\s+test|pytest|go\s+test|make\s+test|\.\/target\/|gh\s+run\s+watch)\b/.test(e.cmd)); },
  },
  "perf-evidence": {
    what: "a benchmark or backtest command runs later in the session",
    eval: (evs, f) => { const a = bash(after(evs, Date.parse(f.ts), "")); if (!a.length) return null; return a.some((e) => /\b(cargo\s+bench|hyperfine|criterion|--bench|backtest|\bperf\s|bench)/.test(e.cmd)); },
  },
  "codegraph-bash": CODEGRAPH,
  "codegraph-tools": CODEGRAPH,
  "sandbox-worktree": SANDBOX,
  "sandbox-worktree-enter": SANDBOX,
  "sandbox-worktree-subagent": SANDBOX,
  "kubectl-local": { what: "the retry runs kubectl without ssh", eval: (evs, f) => { const n = bash(after(evs, Date.parse(f.ts), f.agent ?? "")).find((e) => /\bkubectl\b/.test(e.cmd)); return n ? !/\bssh\b/.test(n.cmd) : null; } },
  "skill-mention": { what: "a Skill call is among the next three tool calls", eval: (evs, f) => { const n = tools(after(evs, Date.parse(f.ts), "")).slice(0, 3); if (!n.length) return null; return n.some((e) => e.name === "Skill"); } },
  "ci-baseline": { what: "the base branch's runs are checked", eval: (evs, f) => { const a = bash(after(evs, Date.parse(f.ts), "")); if (!a.length) return null; return a.some((e) => /\bgh\s+run\s+list\b[^|;]*--branch/.test(e.cmd)); } },
};
const compliance: Record<string, { fired: number; evaluable: number; ok: number }> = {};
p(pad("rule", 26) + rpad("fires", 6) + rpad("evald", 6) + rpad("ok", 4) + rpad("rate", 6) + "  predicate / non-compliant sessions");
for (const [id, pr] of Object.entries(PREDICATES)) {
  if (!ruleFiles.has(id)) continue;
  let fired = 0, evaluable = 0, ok = 0; const bad: string[] = [];
  for (const [sess, fires] of firesBySession) {
    const evs = timelines.get(sess);
    for (const f of fires) {
      if (f.rule !== id) continue;
      fired++;
      if (!evs) continue;
      const v = pr.eval(evs, f);
      if (v === null) continue;
      evaluable++;
      if (v) ok++; else if (bad.length < 3 && !bad.includes(sess)) bad.push(sess);
    }
  }
  compliance[id] = { fired, evaluable, ok };
  p(pad(id, 26) + rpad(fired, 6) + rpad(evaluable, 6) + rpad(ok, 4) + rpad(pct(ok, evaluable), 6) + "  " + pr.what + (bad.length ? `  ← ${bad.join(", ")}` : ""));
}
p("no predicate: review-discipline (report shape), agent-orchestration (informational). fires without a transcript in the window are not evaluable.");

// ---------------------------------------------------------------- hooks + plugins
h("hooks  $AP/claude/settings.json");
const hooks = settings.hooks ?? {};
const scriptOf = (cmd: string) => cmd.match(/(['"])([^'"]+\.(?:sh|ts|py|js|fish))\1|(\S+\.(?:sh|ts|py|js|fish))\b/);
let hookCount = 0;
for (const [event, groups] of Object.entries<any>(hooks)) {
  for (const g of groups as any[]) {
    for (const hk of g.hooks ?? []) {
      hookCount++;
      const cmd: string = hk.command ?? hk.url ?? hk.prompt ?? "?";
      const m = scriptOf(cmd);
      const script = m?.[2] ?? m?.[3];
      const ok = script ? (existsSync(script.replace(/^~/, HOME)) ? "ok" : "MISSING") : "-";
      p(pad(event, 20) + pad(g.matcher ?? "*", 34) + pad(hk.if ?? "", 14) + pad(`t=${hk.timeout ?? "def"}${hk.async ? " async" : ""}`, 12) + pad(ok, 8) + (script ? basename(script) : trunc(cmd, 50)));
    }
  }
}
p(`${hookCount} hook entries across ${Object.keys(hooks).length} events`);
const enabled = settings.enabledPlugins ?? {};
const cache = join(HOME, ".claude", "plugins", "cache");
const disabledWithCache: string[] = [];
for (const [name, on] of Object.entries(enabled)) {
  if (on) continue;
  const short = name.split("@")[0]!;
  const hit = existsSync(cache) && readdirSync(cache).some((mk) => existsSync(join(cache, mk, short)));
  if (hit) disabledWithCache.push(short);
}
p(`plugins enabled: ${Object.entries(enabled).filter(([, v]) => v).map(([k]) => k.split("@")[0]).join(", ") || "none"}`);
p(`plugins disabled but still in cache: ${disabledWithCache.join(", ") || "none"}`);

// ---------------------------------------------------------------- memory
h("memory  ~/.claude/projects/*/memory   (cap: 200 lines / 25 KB of MEMORY.md load)");
const memRows: { files: number; line: string }[] = [];
const memIndex: Record<string, number> = {};
let totalMem = 0, topType = 0, nestedType = 0, noDesc = 0;
const projReads = new Map<string, Set<string>>();
for (const key of memReads.keys()) {
  const proj = key.split("/memory/")[0]!, file = key.split("/memory/")[1]!;
  (projReads.get(proj) ?? projReads.set(proj, new Set()).get(proj)!).add(file);
}
if (existsSync(projectsDir)) {
  for (const proj of readdirSync(projectsDir).sort()) {
    const md = join(projectsDir, proj, "memory");
    const idx = join(md, "MEMORY.md");
    if (!existsSync(idx)) continue;
    const files = readdirSync(md).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    totalMem += files.length;
    const index = readFileSync(idx, "utf8");
    const ilines = index.split("\n").length, ibytes = index.length;
    const unindexed = files.filter((f) => !index.includes(f));
    const dangling = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]!).filter((f) => !existsSync(join(md, f)));
    for (const f of files) {
      const t = readFileSync(join(md, f), "utf8");
      const fm = t.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      if (/^type:/m.test(fm)) topType++; else if (/^\s+type:/m.test(fm)) nestedType++;
      if (!/^description:/m.test(fm)) noDesc++;
    }
    const readSet = projReads.get(proj) ?? new Set<string>();
    const over = ilines > 200 || ibytes > 25_000 ? "OVER" : "";
    const short = proj.replace(new RegExp("^" + HOME_SLUG + "-"), "");
    memIndex[short] = ilines;
    memRows.push({ files: files.length, line: pad(trunc(short, 44), 46) + rpad(files.length, 6) + rpad(ilines, 7) + rpad(ibytes, 8) + pad(" " + over, 6) + rpad(unindexed.length, 6) + rpad(dangling.length, 6) + rpad([...readSet].filter((f) => f !== "MEMORY.md").length, 8) + rpad((memReads.get(`${proj}/memory/MEMORY.md`) ?? new Set()).size, 8) + (unindexed.length ? "  unindexed: " + unindexed.slice(0, 3).join(", ") : "") + (dangling.length ? "  dangling: " + dangling.slice(0, 3).join(", ") : "") });
  }
}
p(pad("project", 46) + rpad("files", 6) + rpad("idx-ln", 7) + rpad("idx-B", 8) + pad(" cap", 6) + rpad("unidx", 6) + rpad("dangl", 6) + rpad("read-f", 8) + rpad("idx-rd", 8));
for (const r of memRows.sort((a, b) => b.files - a.files).slice(0, 20)) p(r.line);
p(`${totalMem} topic files; frontmatter type: nested metadata.type=${nestedType}, top-level type=${topType}, missing description=${noDesc}`);
p("most-read topic files (sessions):");
for (const [k, s] of [...memReads.entries()].filter(([k]) => !k.endsWith("/MEMORY.md")).sort((a, b) => b[1].size - a[1].size).slice(0, 10)) p(`  ${rpad(s.size, 4)}  ${trunc(k.replace(new RegExp("^" + HOME_SLUG + "-"), ""), 100)}`);

// ---------------------------------------------------------------- skills
const cap = settings.skillListingMaxDescChars ?? 1536;
h(`skills  ~/.claude/skills   listing cap=${cap} chars/description`);
const skillsDir = join(HOME, ".claude", "skills");
const dangling: string[] = [], frozen: string[] = [], overCap: string[] = [];
let modelInvoked = 0, userInvoked = 0, listingBytes = 0;
const skillNames = new Set<string>();
for (const name of existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []) {
  const d = join(skillsDir, name);
  let st; try { st = lstatSync(d); } catch { continue; }
  if (st.isSymbolicLink()) { if (!existsSync(d)) { dangling.push(name); continue; } } else if (st.isDirectory()) frozen.push(name); else continue;
  skillNames.add(name);
  const sk = read(join(d, "SKILL.md")); if (!sk) { dangling.push(name + " (no SKILL.md)"); continue; }
  const fm = sk.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const desc = fm.match(/^description:\s*([\s\S]*?)(?=\n\S|$)/m)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const userOnly = /^disable-model-invocation:\s*true/m.test(fm) || settings.skillOverrides?.[name] === "user-invocable-only";
  if (settings.skillOverrides?.[name] === "off") continue;
  if (userOnly) userInvoked++; else { modelInvoked++; listingBytes += Math.min(desc.length, cap) + name.length; }
  if (!userOnly && desc.length > cap) overCap.push(`${name}:${desc.length}`);
}
p(`model-invoked (description always in context): ${modelInvoked}  ~${tok(listingBytes)} tok/request   user-invoked: ${userInvoked}   off: ${Object.values(settings.skillOverrides ?? {}).filter((v) => v === "off").length}`);
p(`descriptions over cap (tail invisible): ${overCap.join(", ") || "none"}`);
p(`dangling: ${dangling.join(", ") || "none"}   frozen real dirs: ${frozen.join(", ") || "none"}`);
const deadOverrides = Object.keys(settings.skillOverrides ?? {}).filter((k) => !skillNames.has(k));
p(`overrides naming nothing under ~/.claude/skills (plugin skill or dead): ${deadOverrides.join(", ") || "none"}`);
p("invocations in window (sessions), from skill expansions in transcripts:");
p("  " + [...skillUse.entries()].sort((a, b) => b[1].size - a[1].size).map(([k, s]) => `${k}×${s.size}`).join("  "));
const unused = [...skillNames].filter((n) => !skillUse.has(n) && settings.skillOverrides?.[n] !== "off");
p(`never invoked in window: ${unused.join(", ") || "none"}`);

// ---------------------------------------------------------------- permissions + failures
h("permissions");
const perm = settings.permissions ?? {};
p(`allow=${(perm.allow ?? []).length}  deny=${(perm.deny ?? []).length}  ask=${(perm.ask ?? []).length}  defaultMode=${perm.defaultMode ?? "?"}  autoMode.allow=${(settings.autoMode?.allow ?? []).length}`);
for (const k of ["permission-denied", "tool-failure"]) {
  const rs = rows.filter((r) => r.rule === k);
  const m = new Map<string, number>();
  for (const r of rs) bump(m, trunc((r.detail ?? "").replace(/\s+/g, " "), 90));
  p(`${k}: ${rs.length} rows in ${new Set(rs.map((r) => r.session)).size} sessions; top:`);
  for (const [d, n] of top(m, 5)) p(`  ${rpad(n, 4)}  ${d}`);
}

// ---------------------------------------------------------------- corrections
h(`corrections  (typed prompts shaped like corrections: ${corrections.length} of ${typedPrompts}; heuristic regex, verify each in its transcript)`);
const byProj = new Map<string, number>();
for (const c of corrections) bump(byProj, c.proj);
p("by project: " + top(byProj, 8).map(([k, n]) => `${trunc(k, 30)}×${n}`).join("  "));
for (const c of corrections.slice(-15)) p(`  [${c.sess} ${trunc(c.proj, 28)}] ${trunc(c.text, 120)}`);

// ---------------------------------------------------------------- cost ledger (tier 1) + baseline deltas
const MEASURE_FILE = join(HOME, "claude", "harness-measure.jsonl");
let lastMeasure: any = null;
try { const ml = (read(MEASURE_FILE) ?? "").trim().split("\n").filter(Boolean).pop(); if (ml) lastMeasure = JSON.parse(ml); } catch { /* ignore */ }
const RATIO = lastMeasure?.globalTokens && lastMeasure?.globalBytes ? lastMeasure.globalTokens / lastMeasure.globalBytes : 0.25;
const tokc = (bytes: number) => Math.round(bytes * RATIO);
h(`cost ledger  (per session; tokens = bytes × ${RATIO.toFixed(3)} — ${lastMeasure ? `calibrated by ablate.ts measure on ${lastMeasure.date}: global CLAUDE.md = ${lastMeasure.globalTokens} tokens exact` : "UNCALIBRATED 4 B/tok guess; run `bun ablate.ts measure`"}; rule injections weighted by fires/session)`);
const memIdxBytes = existsSync(projectsDir) ? readdirSync(projectsDir).map((pr) => read(join(projectsDir, pr, "memory", "MEMORY.md"))?.length ?? 0).filter(Boolean) : [];
const memIdxAvg = memIdxBytes.length ? Math.round(memIdxBytes.reduce((a, b) => a + b, 0) / memIdxBytes.length) : 0;
const ledger: Record<string, number> = {
  "global CLAUDE.md": cm?.length ?? 0,
  "rule injections (weighted by fires/session)": Math.round(injectedBytesPerSession),
  "skill listing (model-invoked descriptions)": listingBytes,
  "MEMORY.md index (avg over projects that have one)": memIdxAvg,
};
for (const [k, v] of Object.entries(ledger)) p(`  ${pad(k, 52)} ${rpad(v, 7)} B  ~${rpad(tokc(v), 5)} tok`);
const perSessionTok = tokc(Object.values(ledger).reduce((a, b) => a + b, 0));
const perMonth = Math.round(perSessionTok * sessionsStarted * (30 / DAYS));
p(`  ${pad("total always-on (excl. project CLAUDE.md files)", 52)} ${rpad("", 7)}    ~${rpad(perSessionTok, 5)} tok/session  × ${sessionsStarted} sessions/${DAYS}d ≈ ${perMonth} tok/month`);

const baseline = {
  date: new Date().toISOString().slice(0, 10), version, model: settings.model ?? null, days: DAYS, sessions: sessionsStarted,
  claudeMdLines: cmLines, claudeMdBytes: cm?.length ?? 0, rules: ruleFiles.size, injectedBytesPerSession: Math.round(injectedBytesPerSession),
  modelInvokedSkills: modelInvoked, listingBytes, perSessionTok, tokPerByte: +RATIO.toFixed(3), typedPrompts, corrections: corrections.length,
  firesPerSession: Object.fromEntries([...ruleFiles.keys()].map((id) => [id, sessionsStarted ? +(((byRule.get(id)?.fires ?? 0) / sessionsStarted).toFixed(3)) : 0])),
  compliance: Object.fromEntries(Object.entries(compliance).map(([id, c]) => [id, c.evaluable ? +((c.ok / c.evaluable).toFixed(2)) : null])),
  memoryIndexLines: memIndex,
};
const prevLine = (read(BASELINES) ?? "").trim().split("\n").filter(Boolean).pop();
if (prevLine) {
  try {
    const prev = JSON.parse(prevLine);
    p(`deltas vs baseline ${prev.date} (${prev.version}, ${prev.sessions} sessions):`);
    const d = (label: string, a: number, b: number, unit = "") => p(`  ${pad(label, 30)} ${rpad(b, 8)} → ${rpad(a, 8)}  (${a - b >= 0 ? "+" : ""}${Math.round((a - b) * 100) / 100}${unit})`);
    d("tok/session (always-on)", perSessionTok, prev.perSessionTok);
    d("CLAUDE.md bytes", cm?.length ?? 0, prev.claudeMdBytes);
    d("rules", ruleFiles.size, prev.rules);
    d("corrections", corrections.length, prev.corrections, ` of ${typedPrompts} vs ${prev.typedPrompts} prompts`);
    for (const [id, rate] of Object.entries(baseline.compliance)) {
      const pr = prev.compliance?.[id];
      if (rate !== null && pr !== null && pr !== undefined && Math.abs((rate as number) - pr) >= 0.1) p(`  ${pad("compliance " + id, 30)} ${rpad(pr, 8)} → ${rpad(rate, 8)}`);
    }
  } catch { p("baseline file present but its last line is not JSON"); }
} else p(`no previous baseline (${BASELINES})`);
if (flag("--baseline")) {
  appendFileSync(BASELINES, JSON.stringify(baseline) + "\n");
  p(`baseline appended → ${BASELINES}`);
}

console.log(out.join("\n"));
