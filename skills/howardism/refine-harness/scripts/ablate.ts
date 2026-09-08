#!/usr/bin/env bun
/**
 * refine-harness ablate — headless A/B probes for the global CLAUDE.md (tier 3) and exact
 * prompt-token measurement (tier 1).
 *
 *   bun ablate.ts measure [--variant <file>] [--model sonnet]
 *       Exact always-on prompt tokens from 1-turn `claude -p` runs in an empty fixture cwd:
 *       as-configured, without the global CLAUDE.md, and (optionally) with <file> in its
 *       place. The deltas are the exact token cost of the global CLAUDE.md and of a
 *       proposed variant. Three cheap calls.
 *
 *   bun ablate.ts run --line "<substring>" [--replace "<text>"] [--probe <name> ...]
 *                     [--runs 3] [--model sonnet] [--parallel 2] [--keep]
 *       For each probe, run arm A (global CLAUDE.md as is) and arm B (the one line matching
 *       <substring> removed, or replaced by <text>) N times each, score every run with the
 *       probe's deterministic check, and print per-arm pass rates and metrics. No
 *       difference across arms is evidence the line is a no-op for that probe — at N=3 a
 *       small effect can hide in noise, so say so when reporting.
 *
 *   bun ablate.ts probes            list probes/*.json
 *
 * Isolation: each run gets a fresh git-initialised fixture dir under the OS tmpdir, the
 * global CLAUDE.md is excluded via `claudeMdExcludes` and the arm's text is served as the
 * fixture's project CLAUDE.md, auto memory is off, sessions are not persisted, and the
 * rules engine writes its audit to a throwaway RULES_ENGINE_STATE_DIR. Skills, hooks, MCP
 * and the system prompt are identical across arms and cancel out.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const HOME = homedir();
// One JSON line per `measure` run; inventory.ts reads the last line to calibrate its ledger.
const MEASURE_FILE = join(HOME, "claude", "harness-measure.jsonl");
const SKILL_DIR = dirname(import.meta.dir);
const PROBES_DIR = join(SKILL_DIR, "probes");
const GLOBAL_LINK = join(HOME, ".claude", "CLAUDE.md");
const GLOBAL_REAL = existsSync(GLOBAL_LINK) ? realpathSync(GLOBAL_LINK) : GLOBAL_LINK;
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : def; };
const opts = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const has = (name: string) => args.includes(name);
const MODEL = opt("--model", "sonnet");
const RUN_ROOT = join(tmpdir(), "refine-harness-ablate", new Date().toISOString().replace(/[:.]/g, "-"));
const STATE_DIR = join(RUN_ROOT, "engine-state");

type Probe = {
  name: string; line?: string; prompt: string; files?: Record<string, string>;
  allowedTools?: string; maxTurns?: number; check: Check; metric?: Metric;
};
type Check =
  | { type: "all" | "any"; of: Check[] }
  | { type: "file-contains" | "file-lacks"; path: string; pattern: string }
  | { type: "file-lines-max"; path: string; max: number }
  | { type: "output-matches" | "output-lacks"; pattern: string }
  | { type: "output-max-chars"; max: number }
  | { type: "changed-lines-max"; max: number }
  | { type: "changed-files-only"; allowed: string[] }
  | { type: "new-files-max"; max: number };
type Metric = { type: "changed_lines" | "output_chars" | "num_turns" | "new_files" } | { type: "file_lines"; path: string };
type RunResult = { arm: string; i: number; ok: boolean; pass: boolean | null; metric: number | null; turns: number; cost: number; tokens: number; error: string; dir: string; output: string };

const sh = (c: string[], cwd?: string, env?: Record<string, string>) => Bun.spawnSync({ cmd: c, cwd, env: { ...process.env, ...(env ?? {}) }, stdout: "pipe", stderr: "pipe" });
const settingsJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ claudeMdExcludes: [GLOBAL_LINK, GLOBAL_REAL], autoMemoryEnabled: false, ...extra });

async function claude(cwd: string, prompt: string, extra: string[]): Promise<{ json: any; raw: string; err: string }> {
  const proc = Bun.spawn({
    cmd: ["claude", "-p", prompt, "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--settings", settingsJson(), ...extra],
    cwd, env: { ...process.env, RULES_ENGINE_STATE_DIR: STATE_DIR }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 600_000);
  const [raw, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited; clearTimeout(timer);
  let json: any = null; try { json = JSON.parse(raw); } catch { /* not json */ }
  return { json, raw, err };
}
const tokensOf = (j: any) => { const u = j?.usage ?? {}; return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0); };

function loadProbes(): Probe[] {
  if (!existsSync(PROBES_DIR)) return [];
  return readdirSync(PROBES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(PROBES_DIR, f), "utf8")) as Probe);
}

function fixture(dir: string, claudeMdText: string, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), content); }
  writeFileSync(join(dir, "CLAUDE.md"), claudeMdText);
  const g = (...a: string[]) => sh(["git", "-c", "user.email=ablate@local", "-c", "user.name=ablate", "-c", "commit.gpgsign=false", ...a], dir);
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "fixture");
}

function gitChanges(dir: string): { changedLines: number; changedFiles: string[]; newFiles: string[] } {
  const status = sh(["git", "status", "--porcelain", "--untracked-files=all"], dir).stdout.toString();
  const changedFiles: string[] = [], newFiles: string[] = [];
  for (const l of status.split("\n")) {
    if (!l.trim()) continue;
    const f = l.slice(3).trim();
    if (f === "CLAUDE.md") continue;
    if (l.startsWith("??")) newFiles.push(f); else changedFiles.push(f);
  }
  let changedLines = 0;
  for (const l of sh(["git", "diff", "--numstat", "--", ".", ":!CLAUDE.md"], dir).stdout.toString().split("\n")) {
    const m = l.match(/^(\d+)\t(\d+)\t/); if (m) changedLines += Number(m[1]) + Number(m[2]);
  }
  return { changedLines, changedFiles, newFiles };
}

function evalCheck(c: Check, ctx: { dir: string; output: string; ch: ReturnType<typeof gitChanges> }): boolean {
  const file = (p: string) => (existsSync(join(ctx.dir, p)) ? readFileSync(join(ctx.dir, p), "utf8") : "");
  switch (c.type) {
    case "all": return c.of.every((x) => evalCheck(x, ctx));
    case "any": return c.of.some((x) => evalCheck(x, ctx));
    case "file-contains": return new RegExp(c.pattern, "m").test(file(c.path));
    case "file-lacks": return !new RegExp(c.pattern, "m").test(file(c.path));
    case "file-lines-max": return file(c.path).split("\n").length <= c.max;
    case "output-matches": return new RegExp(c.pattern, "m").test(ctx.output);
    case "output-lacks": return !new RegExp(c.pattern, "m").test(ctx.output);
    case "output-max-chars": return ctx.output.length <= c.max;
    case "changed-lines-max": return ctx.ch.changedLines <= c.max;
    case "changed-files-only": return [...ctx.ch.changedFiles, ...ctx.ch.newFiles].every((f) => c.allowed.includes(f));
    case "new-files-max": return ctx.ch.newFiles.length <= c.max;
  }
}
function evalMetric(m: Metric | undefined, ctx: { dir: string; output: string; ch: ReturnType<typeof gitChanges>; turns: number }): number | null {
  if (!m) return null;
  switch (m.type) {
    case "changed_lines": return ctx.ch.changedLines;
    case "output_chars": return ctx.output.length;
    case "num_turns": return ctx.turns;
    case "new_files": return ctx.ch.newFiles.length;
    case "file_lines": { const p = join(ctx.dir, m.path); return existsSync(p) ? readFileSync(p, "utf8").split("\n").length : null; }
  }
}

async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const results: T[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (next < items.length) { const i = next++; results[i] = await items[i]!(); } }));
  return results;
}

// ---------------------------------------------------------------- measure
async function measure() {
  const variant = opt("--variant", "");
  const global = readFileSync(GLOBAL_REAL, "utf8");
  const arms: { name: string; claudeMd: string | null; exclude: boolean }[] = [
    { name: "as-configured", claudeMd: null, exclude: false },
    { name: "no-global", claudeMd: null, exclude: true },
  ];
  if (variant) arms.push({ name: `variant ${variant}`, claudeMd: readFileSync(variant, "utf8"), exclude: true });
  const prompt = "Reply with exactly: OK";
  const res: { name: string; tokens: number; cost: number; err: string }[] = [];
  for (const arm of arms) {
    const dir = join(RUN_ROOT, "measure", arm.name.replace(/\W+/g, "-"));
    mkdirSync(dir, { recursive: true });
    if (arm.claudeMd !== null) writeFileSync(join(dir, "CLAUDE.md"), arm.claudeMd);
    const settings = arm.exclude ? settingsJson() : JSON.stringify({ autoMemoryEnabled: false });
    const proc = Bun.spawn({ cmd: ["claude", "-p", prompt, "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--max-turns", "1", "--settings", settings], cwd: dir, env: { ...process.env, RULES_ENGINE_STATE_DIR: STATE_DIR }, stdout: "pipe", stderr: "pipe" });
    const [raw, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    let j: any = null; try { j = JSON.parse(raw); } catch { /* */ }
    res.push({ name: arm.name, tokens: j ? tokensOf(j) : 0, cost: j?.total_cost_usd ?? 0, err: j ? "" : (err || raw).slice(0, 200) });
  }
  console.log(`# ablate measure  model=${MODEL}  global=${GLOBAL_REAL} (${global.length} B, ${global.split("\n").length} lines)`);
  for (const r of res) console.log(`  ${r.name.padEnd(40)} ${String(r.tokens).padStart(7)} prompt tokens   $${r.cost.toFixed(4)}${r.err ? "   ERROR " + r.err : ""}`);
  const base = res[0]!.tokens, none = res[1]!.tokens;
  if (base && none) console.log(`  global CLAUDE.md costs ${base - none} tokens per request (bytes/4 estimate was ${Math.round(global.length / 4)})`);
  if (res[2] && res[2].tokens && none) console.log(`  variant costs ${res[2].tokens - none} tokens per request (${res[2].tokens - base >= 0 ? "+" : ""}${res[2].tokens - base} vs as-configured)`);
  console.log(`  total $${res.reduce((a, r) => a + r.cost, 0).toFixed(4)}; fixtures under ${RUN_ROOT}`);
  if (base && none) {
    appendFileSync(MEASURE_FILE, JSON.stringify({
      date: new Date().toISOString().slice(0, 10), model: MODEL, globalBytes: global.length, globalLines: global.split("\n").length,
      asConfigured: base, noGlobal: none, globalTokens: base - none,
      variant: res[2] && res[2].tokens ? { file: variant, tokens: res[2].tokens - none } : null,
    }) + "\n");
    console.log(`  recorded → ${MEASURE_FILE} (inventory.ts calibrates its ledger from the last line)`);
  }
  if (!has("--keep")) rmSync(RUN_ROOT, { recursive: true, force: true });
}

// ---------------------------------------------------------------- run
async function run() {
  const line = opt("--line", "");
  if (!line) { console.error("run needs --line <substring of one global CLAUDE.md line>"); process.exit(2); }
  const global = readFileSync(GLOBAL_REAL, "utf8");
  const lines = global.split("\n");
  const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => l.toLowerCase().includes(line.toLowerCase()));
  if (hits.length !== 1) { console.error(`--line must match exactly one line; matched ${hits.length}:\n` + hits.map(([l, i]) => `  ${i + 1}: ${l}`).join("\n")); process.exit(2); }
  const [hitLine, hitIdx] = hits[0]!;
  const replace = opt("--replace", "");
  const armB = lines.slice(); if (replace) armB[hitIdx] = replace; else armB.splice(hitIdx, 1);
  const runs = Number(opt("--runs", "3")) || 3;
  const parallel = Number(opt("--parallel", "2")) || 2;
  const wanted = opts("--probe");
  const probes = loadProbes().filter((pr) => (wanted.length ? wanted.includes(pr.name) : !pr.line || hitLine.toLowerCase().includes(pr.line.toLowerCase())));
  if (!probes.length) { console.error(`no probe matches; pass --probe <name> (available: ${loadProbes().map((p) => p.name).join(", ")})`); process.exit(2); }
  mkdirSync(STATE_DIR, { recursive: true });
  console.log(`# ablate run  model=${MODEL}  runs=${runs}/arm  parallel=${parallel}`);
  console.log(`line ${hitIdx + 1}: ${hitLine}`);
  console.log(replace ? `arm B replaces it with: ${replace}` : "arm B removes it");
  let totalCost = 0;
  for (const probe of probes) {
    const jobs: (() => Promise<RunResult>)[] = [];
    for (const [arm, text] of [["with", global], ["without", armB.join("\n")]] as const) {
      for (let i = 1; i <= runs; i++) {
        jobs.push(async () => {
          const dir = join(RUN_ROOT, `${probe.name}-${arm}-${i}`);
          fixture(dir, text, probe.files ?? {});
          const extra = ["--permission-mode", "acceptEdits", "--allowedTools", probe.allowedTools ?? "Read,Edit,Write,Glob,Grep", "--max-turns", String(probe.maxTurns ?? 15)];
          const { json, raw, err } = await claude(dir, probe.prompt, extra);
          const output = String(json?.result ?? "");
          const ch = gitChanges(dir);
          const turns = Number(json?.num_turns ?? 0);
          const ctx = { dir, output, ch, turns };
          const ok = !!json && !json.is_error;
          return { arm, i, ok, pass: ok ? evalCheck(probe.check, ctx) : null, metric: ok ? evalMetric(probe.metric, ctx) : null, turns, cost: Number(json?.total_cost_usd ?? 0), tokens: json ? tokensOf(json) : 0, error: ok ? "" : (json?.result ?? err ?? raw).slice(0, 160), dir, output };
        });
      }
    }
    const results = await pool(jobs, parallel);
    console.log(`\n## probe ${probe.name}  (${probe.metric?.type ?? "no metric"})`);
    console.log(`arm      run  pass  metric  turns   cost   error`);
    for (const r of results) { totalCost += r.cost; console.log(`${r.arm.padEnd(8)} ${String(r.i).padStart(3)}  ${r.pass === null ? "  -" : r.pass ? "PASS" : "FAIL"}  ${String(r.metric ?? "-").padStart(6)}  ${String(r.turns).padStart(5)}  $${r.cost.toFixed(3)}  ${r.error}`); }
    for (const arm of ["with", "without"]) {
      const rs = results.filter((r) => r.arm === arm && r.ok);
      const passes = rs.filter((r) => r.pass).length;
      const ms = rs.map((r) => r.metric).filter((m): m is number => m !== null);
      const mean = ms.length ? (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1) : "-";
      console.log(`${arm.padEnd(8)} pass ${passes}/${rs.length}  metric mean ${mean}  [${ms.join(", ")}]  turns mean ${(rs.reduce((a, r) => a + r.turns, 0) / Math.max(1, rs.length)).toFixed(1)}`);
    }
    if (has("--keep")) console.log(`fixtures kept under ${RUN_ROOT}`);
  }
  console.log(`\ntotal $${totalCost.toFixed(3)} across ${probes.length} probe(s) × 2 arms × ${runs} runs. Same pass rate and metric in both arms = no measurable effect of the line on these probes at this sample size.`);
  if (!has("--keep")) rmSync(RUN_ROOT, { recursive: true, force: true });
}

if (cmd === "measure") await measure();
else if (cmd === "run") await run();
else if (cmd === "probes") for (const pr of loadProbes()) console.log(`${pr.name.padEnd(20)} line≈"${pr.line ?? "-"}"  check=${pr.check.type}  metric=${pr.metric?.type ?? "-"}  prompt: ${pr.prompt.slice(0, 80)}`);
else console.log("usage: bun ablate.ts measure [--variant <file>] | run --line <substr> [--replace <text>] [--probe <name>] [--runs N] [--parallel N] [--keep] | probes   (--model sonnet)");
