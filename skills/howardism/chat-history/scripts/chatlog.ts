#!/usr/bin/env bun
// Search / read past Claude Code transcripts and Codex rollouts.
//   bun chatlog.ts search <query> [--source claude|codex|all] [--days N] [--project sub]
//                                 [--files N] [--hits N] [--tools] [--paths-only]
//   bun chatlog.ts show <session-id|path> [--grep re] [--tools] [--width N] [--tail N] [--last]
//   bun chatlog.ts prompts [--days N] [--project sub] [--grep re] [--width N] [--tail N] [--include-agents]
//   bun chatlog.ts sessions [--source claude|codex|all] [--days N] [--project sub] [--limit N] [--include-agents]
//   bun chatlog.ts selfcheck
// search/prompts default --days 30, sessions defaults --days 7; --days 0 means unlimited.
// --include-agents opts subagent transcripts (Claude <parent-uuid>/subagents/agent-*.jsonl, Codex
// rollouts whose session_meta names a parent_thread_id) back into prompts/sessions.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";

const HOME = homedir();
const CLAUDE_DIR = `${HOME}/.claude/projects`;
const CODEX_DIR = `${HOME}/.codex/sessions`;

const argv = process.argv.slice(2);

// --- flag validation (pure — selfcheck exercises these without spawning or exiting) ---
type FlagSpec = Record<string, "bool" | "num" | "str">;
const CMD_FLAGS: Record<string, FlagSpec> = {
  search: { source: "str", days: "num", project: "str", files: "num", hits: "num", tools: "bool", "paths-only": "bool" },
  show: { grep: "str", tools: "bool", width: "num", tail: "num", last: "bool" },
  prompts: { days: "num", project: "str", grep: "str", width: "num", tail: "num", "include-agents": "bool" },
  sessions: { source: "str", days: "num", project: "str", limit: "num", "include-agents": "bool" },
  selfcheck: {},
};

export function findBadFlagValue(args: string[], spec: FlagSpec): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (!(name in spec))
      return `unknown flag --${name} (expected: ${Object.keys(spec).map((f) => `--${f}`).join(", ")})`;
    if (spec[name] === "bool") continue;
    const v = args[i + 1];
    if (v === undefined) return `--${name} needs a value`;
    if (v.startsWith("-") && v !== "-")
      return `--${name} needs a value (got "${v}"); to match a literal "${v}" use --${name} '[-]${v.slice(1)}'`;
    if (spec[name] === "num" && !(Number.isFinite(Number(v)) && Number(v) >= 0))
      return `--${name} must be a non-negative number (got "${v}")`;
  }
  return null;
}

const BOOL_FLAGS = new Set(
  Object.values(CMD_FLAGS).flatMap((spec) => Object.entries(spec).filter(([, t]) => t === "bool").map(([k]) => k)),
);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  const v = i > -1 ? argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith("--") ? v : def;
};
const has = (name: string) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !prev?.startsWith("--") || BOOL_FLAGS.has(prev.slice(2));
});

const showTools = has("tools");
const pathsOnly = has("paths-only");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

type Msg = { role: string; ts: string; text: string };

// --- parsers ---------------------------------------------------------------
export function claudeMsgs(obj: any): Msg[] {
  if (obj?.type !== "user" && obj?.type !== "assistant") return [];
  const ts = obj.timestamp ?? "";
  const content = obj.message?.content;
  if (typeof content === "string") return [{ role: obj.type, ts, text: content }];
  if (!Array.isArray(content)) return [];
  const out: Msg[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) out.push({ role: obj.type, ts, text: p.text });
    else if (p.type === "tool_use")
      out.push({ role: `⚙ ${p.name}`, ts, text: JSON.stringify(p.input ?? {}) });
    else if (p.type === "tool_result") {
      const raw = typeof p.content === "string"
        ? p.content
        : p.content?.map?.((c: any) => c.text ?? "").join(" ") ?? "";
      if (raw) out.push({ role: p.is_error ? "↳ error" : "↳ result", ts, text: raw });
    }
  }
  return out;
}

export function codexMsgs(obj: any): Msg[] {
  if (obj?.type !== "response_item") return []; // event_msg duplicates response_item
  const ts = obj.timestamp ?? "";
  const p = obj.payload ?? {};
  if (p.type === "message") {
    const text = (p.content ?? []).map((c: any) => c.text ?? "").join("").trim();
    return text ? [{ role: p.role ?? "message", ts, text }] : [];
  }
  if (p.type === "function_call" || p.type === "custom_tool_call")
    return [{ role: `⚙ ${p.name ?? "tool"}`, ts, text: String(p.arguments ?? p.input ?? "") }];
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
    return [{ role: "↳ result", ts, text: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "") }];
  if (p.type === "reasoning")
    return [{ role: "· reasoning", ts, text: (p.summary ?? []).map((s: any) => s.text ?? "").join(" ") }];
  return [];
}

const isTool = (m: Msg) => m.role.startsWith("⚙") || m.role.startsWith("↳") || m.role.startsWith("·");

// A raw JSONL line that can't contain the query needn't be parsed — but only when the
// query survives JSON escaping (a `"` or `\` in the pattern would miss escaped text).
export const canPrefilter = (query: string) => !/["\\]/.test(query);

async function parseFile(path: string, prefilter?: RegExp): Promise<Msg[]> {
  const text = await Bun.file(path).text().catch(() => "");
  const codex = path.includes("/.codex/");
  const out: Msg[] = [];
  for (const line of text.split("\n")) {
    if (!line || (prefilter && !prefilter.test(line))) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    out.push(...(codex ? codexMsgs(obj) : claudeMsgs(obj)));
  }
  return out;
}

const sessionOf = (path: string) => {
  const base = path.split("/").pop()!.replace(/\.jsonl$/, "");
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : base;
};
const labelOf = (path: string) =>
  path.includes("/.codex/")
    ? `codex ${path.split("/sessions/")[1]?.slice(0, 10) ?? ""}`
    : `claude ${path.split("/projects/")[1]?.split("/")[0] ?? ""}`;

// Subagent transcripts (<parent-uuid>/subagents/agent-*.jsonl) are agent-authored spawn
// briefs, not prompts the human typed — excluded from prompts/sessions unless opted back in.
export const isSubagentTranscript = (path: string) => path.includes("/subagents/");

// Harness-injected user turns: command wrappers, task notifications, teammate relays and
// stop notices (Claude, all `<...>`), and the AGENTS.md block Codex prepends as a user message.
export const isInjectedTurn = (text: string) =>
  text.startsWith("<") || text.startsWith("# AGENTS.md instructions for");

// --- search ----------------------------------------------------------------
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

// Narrow what rg has to walk: the whole corpus is ~19 GB, and a cold scan of it dwarfs
// every other cost in this script. Falls back to the bare dir whenever pruning can't
// be done safely — the mtime filter below still enforces --days either way.
export async function rgRoots(dir: string, days: number, project: string): Promise<string[]> {
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  if (dir === CODEX_DIR) {
    if (!days) return [dir];
    const roots: string[] = []; // sessions/YYYY/MM/DD, named in local time like the rollout filenames
    for (let i = 0; i <= days; i++) {
      const d = new Date(Date.now() - i * 86_400_000);
      const p = `${dir}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
      if (await isDir(p)) roots.push(p);
    }
    return roots;
  }
  let roots = [dir];
  if (project) {
    const projs = (await readdir(dir)).filter((p) => p.toLowerCase().includes(project.toLowerCase()));
    if (!projs.length) return [];
    roots = projs.map((p) => `${dir}/${p}`);
  }
  if (!days) return roots;
  // ~/.claude/projects has no date layout, so hand rg an explicit recent-file list instead
  const files: string[] = [];
  for (const root of roots) {
    for await (const p of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
      if (Bun.file(p).lastModified >= cutoff) files.push(p);
    }
  }
  return files;
}

// Splits a path list into rg-argv-sized batches (~500 paths each — more than that risks
// hitting argv limits). A short list stays one batch, so a single-directory root list
// stays one rg spawn.
export function chunkPaths(paths: string[], size = 500): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size));
  return out;
}

async function spawnRg(query: string, roots: string[]): Promise<string[]> {
  // --hidden/--no-ignore: both corpora live under dot-directories rg skips by default
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn(["rg", "-l", "-i", "--hidden", "--no-ignore", "-e", query, "--glob", "*.jsonl", ...roots], { stderr: "ignore" }); }
  catch { console.error("rg not found — install ripgrep (brew install ripgrep)"); process.exit(1); }
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split("\n").filter(Boolean);
}

async function rgFiles(query: string, roots: string[]): Promise<string[]> {
  if (!roots.length) return []; // never spawn rg with no paths — it would search cwd
  const results = await Promise.all(chunkPaths(roots).map((batch) => spawnRg(query, batch)));
  return [...new Set(results.flat())];
}

// Codex rollouts carry no project name in their path (date-based sessions/YYYY/MM/DD),
// unlike Claude's <project-slug>/<uuid>.jsonl layout — read the first line's recorded cwd
// instead. Returns "" when the line isn't session_meta, doesn't parse, or has no cwd.
export function codexCwd(firstLine: string): string {
  try {
    const obj = JSON.parse(firstLine);
    return obj?.type === "session_meta" ? (obj.payload?.cwd ?? "") : "";
  } catch { return ""; }
}

// Codex spawns sub-agents as separate rollouts whose session_meta carries parent_thread_id:
// like Claude's subagents/ transcripts they open with an agent-authored brief, not a typed
// prompt. Returns "" for a root thread, a non-meta line, or unparseable input.
export function codexParentThread(firstLine: string): string {
  try {
    const obj = JSON.parse(firstLine);
    return obj?.type === "session_meta" ? (obj.payload?.parent_thread_id ?? "") : "";
  } catch { return ""; }
}

// session_meta lines can run tens of KB (embedded base_instructions), so stream until
// the first newline rather than slicing a fixed byte range that could truncate mid-JSON.
async function readFirstLine(path: string): Promise<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const nl = buf.indexOf("\n");
    if (nl !== -1) { reader.cancel(); return buf.slice(0, nl); }
    if (done) return buf;
  }
}

async function matchesProject(f: string, project: string): Promise<boolean> {
  if (!project) return true;
  if (f.includes("/.codex/")) return codexCwd(await readFirstLine(f)).toLowerCase().includes(project.toLowerCase());
  return f.toLowerCase().includes(project.toLowerCase());
}

async function searchTranscripts(query: string, dir: string, re: RegExp): Promise<string> {
  const days = Number(flag("days", "30"));
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const project = flag("project", "");
  const maxFiles = Number(flag("files", "5"));
  const maxHits = Number(flag("hits", "3"));
  const prefilter = canPrefilter(query) ? re : undefined;

  const matched = await rgFiles(query, await rgRoots(dir, days, project));
  const projectFiltered = (await Promise.all(matched.map(async (f) => ((await matchesProject(f, project)) ? f : null))))
    .filter((f): f is string => f !== null);
  const files = projectFiltered
    .map((f) => ({ f, mtime: Bun.file(f).lastModified }))
    .filter((x) => x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  // The --files budget counts sessions with visible hits only; tool-only sessions are
  // tallied instead of consuming a slot with a placeholder block. Cap files actually
  // parsed so a pathological query can't walk hundreds of transcripts.
  const maxExamine = maxFiles * 4;
  const out: string[] = [];
  let shown = 0, toolOnly = 0, examined = 0, capped = false;
  for (const { f } of files) {
    if (shown >= maxFiles) break;
    if (examined >= maxExamine) { capped = true; break; }
    examined++;
    const all = (await parseFile(f, prefilter)).filter((m) => re.test(m.text));
    const msgs = showTools ? all : all.filter((m) => !isTool(m));
    if (!msgs.length) {
      if (all.length) toolOnly++;
      continue;
    }
    shown++;
    if (pathsOnly) { out.push(`${labelOf(f)}  ${sessionOf(f)}  ${msgs.length} hits  ${f}`); continue; }
    out.push(`\n## ${labelOf(f)}  ${sessionOf(f)}  (${msgs.length} hits)\n   ${f}`);
    for (const m of msgs.slice(0, maxHits)) {
      const i = m.text.search(re);
      const snippet = oneLine(m.text.slice(Math.max(0, i - 120), i + 240));
      out.push(`   [${m.role} ${m.ts.slice(0, 16)}] …${snippet}…`);
    }
  }
  if (toolOnly) out.push(`   (${toolOnly} sessions matched only in tool calls/output — add --tools)`);
  if (capped) out.push(`   (stopped after examining ${maxExamine} files — raise --files if you need more)`);
  else if (files.length > examined) out.push(`   (+${files.length - examined} older matching sessions — raise --files)`);
  return out.join("\n");
}

// --- prompts dump (bulk, no query — feeds the retro skill) -----------------
// Reads user turns straight from the Claude transcripts, mtime-pruned by --days.
async function dumpPrompts(days: number, project: string, includeAgents: boolean) {
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const rows: { ts: string; project: string; sid: string; text: string }[] = [];
  for (const proj of await readdir(CLAUDE_DIR)) {
    const dir = `${CLAUDE_DIR}/${proj}`;
    if (project && !proj.toLowerCase().includes(project.toLowerCase())) continue;
    if (!(await isDir(dir))) continue;
    for await (const p of new Bun.Glob("**/*.jsonl").scan({ cwd: dir, absolute: true })) {
      if (!includeAgents && isSubagentTranscript(p)) continue;
      if (Bun.file(p).lastModified < cutoff) continue;
      for (const m of (await parseFile(p, /"type":"user"/)).filter((m) => m.role === "user")) {
        const text = m.text.trim();
        if (!text || isInjectedTurn(text)) continue;
        if (text.startsWith("Another Claude session sent a message:") || /^\d+ background agents? (was|were) stopped/.test(text)) continue;
        rows.push({ ts: m.ts, project: proj, sid: sessionOf(p), text });
      }
    }
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  return rows;
}

// --- sessions (newest-first listing, no query) ------------------------------
// Streams a file only until its first user message is found — this command needs a
// preview line per session, not a full transcript parse.
async function firstUserPrompt(path: string): Promise<string> {
  const codex = path.includes("/.codex/");
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const u = (codex ? codexMsgs(obj) : claudeMsgs(obj)).find((m) => m.role === "user");
      const text = u?.text.trim();
      if (text && !isInjectedTurn(text)) { reader.cancel(); return text; }
    }
    if (done) return "";
  }
}

async function listSessionFiles(dir: string, days: number, project: string, includeAgents: boolean): Promise<string[]> {
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const roots = await rgRoots(dir, days, dir === CLAUDE_DIR ? project : "");
  const files: string[] = [];
  for (const root of roots) {
    if (root.endsWith(".jsonl")) { files.push(root); continue; } // rgRoots already returned a pruned file list
    for await (const p of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
      if (Bun.file(p).lastModified >= cutoff) files.push(p);
    }
  }
  return includeAgents ? files : files.filter((f) => !isSubagentTranscript(f));
}

async function sessions() {
  const source = flag("source", "all");
  const days = Number(flag("days", "7"));
  const project = flag("project", "");
  const limit = Number(flag("limit", "20"));
  const includeAgents = has("include-agents");
  const want = (s: string) => source === "all" || source === s;

  let files: string[] = [];
  if (want("claude")) files.push(...(await listSessionFiles(CLAUDE_DIR, days, project, includeAgents)));
  if (want("codex")) files.push(...(await listSessionFiles(CODEX_DIR, days, project, includeAgents)));
  if (project) {
    files = (await Promise.all(files.map(async (f) => ((await matchesProject(f, project)) ? f : null))))
      .filter((f): f is string => f !== null);
  }
  const sorted = files
    .map((f) => ({ f, mtime: Bun.file(f).lastModified }))
    .sort((a, b) => b.mtime - a.mtime);
  let shown = 0;
  for (const { f, mtime } of sorted) {
    if (shown >= limit) break;
    // Codex child threads are only detectable from the file's first line, so filter lazily
    // here rather than reading every rollout in the window up front.
    if (!includeAgents && f.includes("/.codex/") && codexParentThread(await readFirstLine(f))) continue;
    shown++;
    const ts = new Date(mtime).toISOString().slice(0, 16).replace("T", " ");
    const prompt = oneLine(await firstUserPrompt(f)).slice(0, 100);
    console.log(`${ts}  ${labelOf(f)}  ${sessionOf(f)}  ${prompt}  ${f}`);
  }
}

// --- show ------------------------------------------------------------------
async function resolve(idOrPath: string): Promise<string | null> {
  if (await Bun.file(idOrPath).exists()) return idOrPath;
  for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
    const glob = new Bun.Glob(`**/*${idOrPath}*.jsonl`);
    for await (const rel of glob.scan({ cwd: dir, absolute: true })) return rel;
  }
  return null;
}

async function show(idOrPath: string) {
  const path = await resolve(idOrPath);
  if (!path) { console.error(`No session matching "${idOrPath}" in ~/.claude/projects or ~/.codex/sessions`); process.exit(1); }
  const grep = flag("grep", "");
  const re = grep ? new RegExp(grep, "i") : null;
  const width = Number(flag("width", "600"));
  const tail = Number(flag("tail", "0"));
  const last = has("last");
  if (last && tail) { console.error("--last and --tail are mutually exclusive"); process.exit(1); }

  const toolsVisible = showTools && !last;
  let msgs = (await parseFile(path)).filter((m) => (toolsVisible || !isTool(m)) && (!re || re.test(m.text)));
  if (last) msgs = msgs.filter((m) => m.role === "assistant").slice(-1);
  else if (tail) msgs = msgs.slice(-tail);
  console.log(`# ${labelOf(path)}  ${sessionOf(path)}  (${msgs.length} messages)\n# ${path}\n`);
  for (const m of msgs) {
    const t = m.text.length > width ? `${m.text.slice(0, width)}… [+${m.text.length - width}]` : m.text;
    console.log(`[${m.role} ${m.ts.slice(0, 19)}]\n${t}\n`);
  }
}

// --- main ------------------------------------------------------------------
const cmd = positional[0];
if (cmd && CMD_FLAGS[cmd]) {
  const err = findBadFlagValue(argv, CMD_FLAGS[cmd]!);
  if (err) { console.error(err); process.exit(1); }
}

if (cmd === "selfcheck") {
  const c = claudeMsgs({ type: "assistant", timestamp: "T", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  console.assert(c.length === 2 && c[0]!.text === "hi" && c[1]!.role === "⚙ Bash", "claudeMsgs", c);
  const x = codexMsgs({ type: "response_item", timestamp: "T", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "yo" }] } });
  console.assert(x.length === 1 && x[0]!.text === "yo", "codexMsgs message", x);
  console.assert(codexMsgs({ type: "event_msg", payload: { type: "user_message", message: "dupe" } }).length === 0, "event_msg skipped");
  console.assert(sessionOf("/a/rollout-2026-08-03T10-23-18-019fc56e-c327-7d11-b805-59c468830c1c.jsonl") === "019fc56e-c327-7d11-b805-59c468830c1c", "sessionOf codex");
  console.assert(canPrefilter("foo bar") && !canPrefilter('say "hi"') && !canPrefilter("a\\sb"), "canPrefilter gate");
  const codexRoots = await rgRoots(CODEX_DIR, 3, "");
  console.assert(codexRoots.every((r) => /\/\d{4}\/\d{2}\/\d{2}$/.test(r)), "rgRoots codex day dirs", codexRoots);
  console.assert((await rgRoots(CODEX_DIR, 0, "")).join() === CODEX_DIR, "rgRoots codex unpruned");
  console.assert((await rgRoots(CLAUDE_DIR, 0, "no-such-project-xyz")).length === 0, "rgRoots empty project");
  console.assert(Array.isArray(await dumpPrompts(1, "no-such-project-xyz", false)), "prompts dump");

  const meta = JSON.stringify({ timestamp: "t", ordinal: 0, type: "session_meta", payload: { session_id: "s", cwd: "/Users/x/proj", originator: "o" } });
  console.assert(codexCwd(meta) === "/Users/x/proj", "codexCwd session_meta");
  console.assert(codexCwd(JSON.stringify({ type: "response_item" })) === "", "codexCwd non-meta");
  console.assert(codexCwd("not json") === "", "codexCwd unparseable");

  console.assert(isSubagentTranscript("/a/parent-uuid/subagents/agent-x.jsonl"), "isSubagentTranscript excludes by default");
  console.assert(!isSubagentTranscript("/a/parent-uuid/session.jsonl"), "isSubagentTranscript non-subagent path");
  const child = JSON.stringify({ type: "session_meta", payload: { id: "c", parent_thread_id: "p", cwd: "/x" } });
  console.assert(codexParentThread(child) === "p" && codexParentThread(meta) === "" && codexParentThread("nope") === "", "codexParentThread");
  console.assert(isInjectedTurn("<command-name>/x</command-name>") && isInjectedTurn("# AGENTS.md instructions for /p\n\n<INSTRUCTIONS>") && !isInjectedTurn("fix the bug"), "isInjectedTurn");

  console.assert(findBadFlagValue(["--days", "abc"], { days: "num" }) !== null, "numeric flag rejects abc");
  console.assert(findBadFlagValue(["--days", "30"], { days: "num" }) === null, "numeric flag accepts 30");
  console.assert(findBadFlagValue(["--grep", "-i"], { grep: "str" }) !== null, "value flag rejects -i");
  console.assert(findBadFlagValue(["--bogus", "x"], { grep: "str" }) !== null, "unknown flag rejected");

  console.assert(chunkPaths(Array.from({ length: 1200 }, (_, i) => String(i))).length === 3, "chunkPaths 1200 -> 3 batches");
  console.assert(chunkPaths(["a"]).length === 1, "chunkPaths short list -> 1 batch");

  console.log("selfcheck ok");
} else if (cmd === "show") {
  if (positional.length > 2) { console.error(`show takes one session id/path, got extra: ${positional.slice(2).join(" ")}`); process.exit(1); }
  await show(positional[1] ?? "");
} else if (cmd === "prompts") {
  const includeAgents = has("include-agents");
  const grepFlag = flag("grep", "");
  const grepRe = grepFlag ? new RegExp(grepFlag, "i") : null;
  const width = Number(flag("width", "500"));
  const tail = Number(flag("tail", "0"));
  let rows = await dumpPrompts(Number(flag("days", "30")), flag("project", ""), includeAgents);
  if (grepRe) rows = rows.filter((r) => grepRe.test(r.text));
  if (tail) rows = rows.slice(-tail);
  console.log(rows.map((r) => `[${r.ts.slice(0, 16)} ${r.project} ${r.sid.slice(0, 8)}] ${width ? oneLine(r.text).slice(0, width) : oneLine(r.text)}`).join("\n"));
} else if (cmd === "search") {
  const query = positional.slice(1).join(" ");
  if (!query) { console.error("usage: bun chatlog.ts search <query> [--source claude|codex|all]"); process.exit(1); }
  let re: RegExp;
  try { re = new RegExp(query, "i"); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  const source = flag("source", "all");
  const want = (s: string) => source === "all" || source === s;
  // rg spawns dominate the runtime and don't contend — run the sources together, print in order
  const blocks = await Promise.all([
    want("claude") ? searchTranscripts(query, CLAUDE_DIR, re) : "",
    want("codex") ? searchTranscripts(query, CODEX_DIR, re) : "",
  ]);
  const text = blocks.filter(Boolean).join("\n");
  console.log(text || `No matches for "${query}".`);
} else if (cmd === "sessions") {
  await sessions();
} else {
  console.error(`usage:
  bun chatlog.ts search <query> [--source claude|codex|all] [--days N] [--project sub] [--files N] [--hits N] [--tools] [--paths-only]
  bun chatlog.ts show <session-id|path> [--grep re] [--tools] [--width N] [--tail N] [--last]
  bun chatlog.ts prompts [--days N] [--project sub] [--grep re] [--width N] [--tail N] [--include-agents]
  bun chatlog.ts sessions [--source claude|codex|all] [--days N] [--project sub] [--limit N] [--include-agents]
  bun chatlog.ts selfcheck`);
  process.exit(1);
}
