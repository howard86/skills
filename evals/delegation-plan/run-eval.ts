#!/usr/bin/env bun
// Runner scaffold for the build-eval / hillclimb loop. Copy this into the
// user's repo and fill in loadCases / runCase / gradeCase below - the I/O
// shape, file naming, resume, and CLI surface are already hillclimb-ready
// so adding v2, v3, ... is `--variant v3`, not a refactor.
//
//   bun run-eval.ts --flow .claude/hillclimb/<name> --variant baseline --reps 2
//
// Structural properties this encodes (so you don't have to remember them):
//   - parameterized by --variant / --model / --reps (no hardcoded A/B pair)
//   - rep-aware filenames + resume (traces/<id>_rep<k>.json)
//   - reads _state.json, never writes it (loop state belongs to the orchestrator) - 
//     the ONE exception is --approve-harness recording `harness_sha` (see below)
//   - refuses to run when the harness (this file + _state.json.harness_paths) has
//     changed since the sha a human last approved with --approve-harness, so a
//     round that edits the runner cannot execute unreviewed under a standing
//     session allowlist
//   - pairwise graders judge against frozen baseline/ref/<id>.* on disk
//   - writes rows as cases complete (crash-safe)
//   - jittered exponential backoff on transient 429/overloaded/5xx errors
//   - hard per-case wall-clock ceiling (--timeout-s; stream keepalives don't reset it)
//   - served-model assertion (response model must match --model; documented alias->snapshot
//     shapes tolerated: 'foo-latest'/'foo-0'/'foo' -> 'foo-20250101' / 'foo@20250101' / 'foo-2025-01-01')
//   - failed attempts land in errors.jsonl with a failure class and, when the call
//     completed, the billed model/usage (never in results.jsonl)
//   - row ids, trace filenames, and frozen refs share one path-safe id
//     (original id kept in meta.original_id when sanitization changed it)

import { createHash } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every output write refuses symlinks: the flow dir is model-influenced, and a
// prompt-injected round can plant `results.jsonl -> ~/.bashrc` where the next
// unattended run would append. POSIX opens O_NOFOLLOW (a symlink fails with
// ELOOP); Windows - where Node leaves O_NOFOLLOW undefined and Bun defines a
// meaningless value - lstat-refuses first. Symlinked parent dirs are
// refused the same way. Same discipline as the report builders' reads.
const WIN = process.platform === 'win32';
const NOFOLLOW = WIN ? 0 : FS.O_NOFOLLOW;
// A guard that cannot tell must refuse: only "no such entry" reads as absent;
// any other lstat failure (EACCES, ENAMETOOLONG, ...) is rethrown, never "no".
const lstatOrNull = p => { try { return lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const isSymlink = p => lstatOrNull(p)?.isSymbolicLink() === true;
// Stderr lines interpolate model-influenced bytes (case ids, error text that
// can echo model output, JSON.parse messages). Strip escape sequences and
// control characters, as build-report-lite.mjs's eprint does, so a planted
// OSC/CSI can't retitle the terminal or forge output lines.
const ESC_SEQ = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const termSafe = s => String(s).replace(ESC_SEQ, '').replace(CONTROL, '');
const eprint = (...a) => console.error(...a.map(termSafe));
// The leaf checks above can't see a symlink on an INTERMEDIATE component
// (lstat and open both resolve those silently), so every open is also bound
// to the flow root: main() captures realpathSync(flow) once, and any path
// whose resolved parent leaves it - e.g. `vdir` or the flow dir itself
// replaced by a directory symlink - is refused when the check sees it.
// Residual, all platforms: the check and the open are separate path lookups
// (Node's sync fs has no openat-style call), so a directory swapped for a
// symlink in between is still followed. This stops a planted link, not a
// writer racing the run.
let flowRealRoot = null;
function assertInFlow(dir, what) {
  if (flowRealRoot == null) throw new Error(`refusing to ${what}: flow root not resolved yet`);
  const dirReal = realpathSync(dir);
  if (dirReal !== flowRealRoot && !dirReal.startsWith(flowRealRoot + (WIN ? '\\' : '/')))
    throw new Error(`refusing to ${what}: ${dir} resolves outside the flow directory`);
}
function openNoFollow(p, flags) {
  if (isSymlink(dirname(p))) throw new Error(`refusing to open through symlinked directory: ${dirname(p)}`);
  assertInFlow(dirname(p), 'open');
  if (WIN && isSymlink(p)) throw new Error(`refusing to open through symlink: ${p}`);
  const fd = openSync(p, flags | NOFOLLOW, 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to use non-regular file: ${p}`);
    // O_NOFOLLOW and lstat cannot see a hard link: a second name for a file
    // outside the flow dir opens as an ordinary regular file. Nothing the
    // runner creates has more than one link, so refuse any that does.
    if (st.nlink > 1) throw new Error(`refusing to use ${p}: it has a second hard link (another name for the same file); replace it with a plain copy if it is yours`);
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}
// writeFileSync on the fd loops until every byte lands (a bare writeSync is
// one write(2) that may return short on ENOSPC and silently truncate a
// results row or trace).
// Opened without O_TRUNC and truncated only after openNoFollow's checks, so a
// refused file keeps its bytes.
function writeFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT);
  try { ftruncateSync(fd, 0); writeFileSync(fd, data); } finally { closeSync(fd); }
}
// POSIX appends atomically under O_APPEND with no position. On Windows, Bun
// writes an O_APPEND handle at offset 0 unless given a position, so there the
// write starts at the current size and re-issues any short write.
function appendFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND);
  try {
    if (!WIN) { writeFileSync(fd, data); return; }
    const buf = Buffer.from(data);
    const start = fstatSync(fd).size;
    for (let off = 0; off < buf.length;) {
      const n = writeSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) throw new Error(`append to ${p} made no progress`);
      off += n;
    }
  } finally { closeSync(fd); }
}
// Reads of the frozen pairwise refs get the same discipline as writes (same
// open guard): the flow dir is model-influenced, so `baseline/ref/<id> ->
// ~/.ssh/id_rsa` planted after the startup preflight must not be read into
// the judge prompt. lexists probes with lstat so a planted symlink still
// counts as "present" at the freeze guard (never overwritten - or followed).
const lexists = p => lstatOrNull(p) != null;
function readFileNoFollow(p) {
  const fd = openNoFollow(p, FS.O_RDONLY);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
// null when the file is absent; any other failure (a planted link included) throws.
function readIfPresent(p) {
  try { return readFileNoFollow(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
function mkdirNoFollow(dir) {
  if (isSymlink(dir)) throw new Error(`refusing to use symlinked directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  // Check after creating: mkdirSync(recursive) follows symlinked ancestors,
  // so a dir minted through one resolves outside the flow root and is refused
  // here before any file lands in it.
  assertInFlow(dir, 'create directory');
}
// Frozen pairwise refs may carry an extension; reader and freeze-guard probe
// the same list so a suffixed ref never gets an extensionless shadow.
const REF_EXTS = ['', '.html', '.txt', '.json'];

// --- fill these in ----------------------------------------------------------
//
// Delegation-plan eval. Each case replays a real Claude Code session up to the
// prompt that triggered implement-with-subagent ("implement all", "apply all"),
// forks it headless in a throwaway clone at the commit of that moment, and sends
// the same prompt again with today's skills loaded. hooks/record-agent.ts records
// and denies every spawn, hooks/guard.ts denies writes outside the clone, and
// the grader scores the recorded spawns against the plan's labelled packages.

import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rmSync, readdirSync } from 'node:fs';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = process.env.EVAL_WORK_ROOT ?? '/private/tmp/claude-501/delegation-plan-eval';
// A runaway replay stops at the turn cap or the wall-clock ceiling. No
// --max-budget-usd: the cap is visible to the root, which shrank its scope to
// fit ("This session started with $8...") where the real session had no limit.
const MAX_TURNS = 60;
const PROJECTS = join(homedir(), '.claude', 'projects');
const projectSlug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

export type Spawn = { input: Record<string, any>; tool: string; brief: string };
type Case = Record<string, any>;
type Run = Record<string, any>;

function findSession(sid: string): string {
  for (const d of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, d, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  throw new Error(`transcript ${sid} not found under ${PROJECTS}`);
}
const readJsonl = (p: string): any[] => readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const textOf = (c: any): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

/** Cases come from cases.json; the trigger text is read from the transcript at run time. */
async function loadCases(): Promise<Case[]> {
  const only = process.env.EVAL_ONLY?.split(',');
  const cases = JSON.parse(readFileSync(join(EVAL_DIR, 'cases.json'), 'utf8'))
    .filter((c: Case) => !only || only.includes(c.id));
  return cases.map((c: Case) => {
    const recs = readJsonl(findSession(c.session));
    const idx = recs.findIndex(r => r.uuid === c.trigger_uuid);
    if (idx < 0) throw new Error(`${c.id}: trigger record ${c.trigger_uuid} missing`);
    return { ...c, prompt: textOf(recs[idx].message?.content),
      tags: [c.shape, `start ${c.start}`, ...(c.weak ? ['weak'] : []), c.project] };
  });
}

function prepare(c: Case, work: string) {
  const clone = join(work, 'repo');
  mkdirSync(work, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { stdio: ['ignore', 'ignore', 'pipe'] });
  git('clone', '--quiet', '--shared', '--no-checkout', c.repo, clone);
  // git 2.55's --shared wrote no alternates file, so the clone held only objects
  // reachable from refs: a session's base on a since-deleted branch was missing.
  // Point the clone at the source's whole object store explicitly.
  const common = execFileSync('git', ['-C', c.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  writeFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), join(common, 'objects') + '\n');
  git('-C', clone, 'checkout', '--quiet', '--detach', c.commit);
  // No remote: a push or fetch from the replayed root must not reach the real repo.
  git('-C', clone, 'remote', 'remove', 'origin');
  // The clone's branches and tags point at the source's current tips, the
  // session's future: one root found its plan "already merged into your local
  // develop" and stopped. Keep only the detached HEAD.
  const refs = execFileSync('git', ['-C', clone, 'for-each-ref', '--format=delete %(refname)'], { encoding: 'utf8' });
  if (refs.trim()) execFileSync('git', ['-C', clone, 'update-ref', '--stdin'], { input: refs, stdio: ['pipe', 'ignore', 'pipe'] });

  const recs = readJsonl(findSession(c.session));
  const idx = recs.findIndex(r => r.uuid === c.trigger_uuid);
  const sid = randomUUID();
  const projDir = join(PROJECTS, projectSlug(clone));
  mkdirSync(projDir, { recursive: true });
  const prefix = recs.slice(0, idx).map(r => ({ ...r, sessionId: sid, ...(r.cwd ? { cwd: clone } : {}) }));
  // A trigger that opened its session has no conversation to resume.
  const resumable = prefix.some(r => r.type === 'user' || r.type === 'assistant');
  if (resumable) writeFileSync(join(projDir, `${sid}.jsonl`), prefix.map(r => JSON.stringify(r)).join('\n') + '\n');

  const settings = join(work, 'settings.json');
  writeFileSync(settings, JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: 'Agent|Task|Workflow|mcp__agent-bridge__Agent',
        hooks: [{ type: 'command', command: `bun ${join(EVAL_DIR, 'hooks', 'record-agent.ts')}` }] },
      { matcher: '.*', hooks: [{ type: 'command', command: `bun ${join(EVAL_DIR, 'hooks', 'guard.ts')}` }] },
    ] },
    ...SANDBOX,
  }, null, 2));
  return { clone, sid: resumable ? sid : null, projDir, settings, prefixLen: resumable ? prefix.length : 0 };
}

// Second layer under hooks/guard.ts: sandboxed Bash writes only to the cwd (the
// clone) and the temp dir, cannot opt out, and reaches only Jev's API, which
// subagent-routing's route.ts calls. https://code.claude.com/docs/en/sandboxing
const SANDBOX = { sandbox: { enabled: true, allowUnsandboxedCommands: false,
  network: { allowedDomains: ['api.typesafe.ai'] } } };

function claudeRun(args: string[], env: Record<string, string>, cwd: string, ceilingMs: number) {
  return new Promise<{ code: number | null; out: string; err: string }>((res, rej) => {
    const p = spawn('claude', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const t = setTimeout(() => p.kill('SIGTERM'), ceilingMs);
    p.on('error', rej);
    p.on('close', code => { clearTimeout(t); res({ code, out, err }); });
  });
}

/** Replay the session headless and collect the root's turn plus every recorded spawn. */
async function runCase(c: Case, ctx: Record<string, any>): Promise<Run> {
  const work = join(WORK_ROOT, `${c.id}-${randomUUID().slice(0, 8)}`);
  const { clone, sid, projDir, settings, prefixLen } = prepare(c, work);
  const spawnLog = join(work, 'spawns.jsonl'), guardLog = join(work, 'guard.jsonl');
  try {
    const model = ctx.model ?? 'claude-opus-5-5';
    const { code, out, err } = await claudeRun(
      ['-p', ...(sid ? ['--resume', sid, '--fork-session'] : []), '--model', model, '--permission-mode', 'bypassPermissions',
       '--settings', settings, '--output-format', 'stream-json', '--verbose',
       '--max-turns', String(MAX_TURNS), c.prompt],
      { EVAL_SPAWN_LOG: spawnLog, EVAL_GUARD_LOG: guardLog, EVAL_CLONE_DIR: clone },
      clone, Math.max(60, (ctx.timeoutS || 1800) - 30) * 1000);
    const events = out.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    // Keep the raw stream beside the traces: it is the only record of a run
    // whose result looks wrong, and the clone is deleted below.
    const streams = join(ctx.flow, ctx.variant, 'streams');
    mkdirSync(streams, { recursive: true });
    writeFileSync(join(streams, `${c.id}-${work.slice(-8)}.jsonl`), out);
    // A Stop hook that blocks the first stop continues the session, and each
    // stop emits its own result event: the last one closes the run.
    const results = events.filter(e => e.type === 'result');
    const result = results.at(-1);
    if (!result) {
      // A stream that ends in api_retry events was killed mid retry storm: the
      // API, not the harness, kept the root from finishing.
      const last = events.filter(e => e.subtype !== 'thinking_tokens').at(-1);
      const storm = last?.subtype === 'api_retry';
      const e: any = new Error(`claude exited ${code} without a result${storm ? ` during API retries (attempt ${last.attempt})` : ''}: ${err.slice(-400)}`);
      e.failure_class = storm || /overloaded|rate.?limit|529|429/i.test(err) ? 'serving' : 'harness';
      if (/overloaded|rate.?limit/i.test(err)) e.status = 529;
      throw e;
    }
    // A run that never got going (resume failure, CLI error) is plumbing, not a
    // delegation decision: it must not be scored as "no workers launched".
    if (result.subtype !== 'success' && result.subtype !== 'error_max_turns' || !result.num_turns) {
      const e: any = new Error(`claude result ${result.subtype}, ${result.num_turns} turns: ${JSON.stringify(result.errors ?? result.result ?? '').slice(0, 400)} ${err.slice(-400)}`);
      e.failure_class = 'harness';
      throw e;
    }
    const transcript: any[] = [{ role: 'system', content: `Replay of session ${c.session} (${prefixLen} prefix records) in a clone of ${c.repo} at ${c.commit}, model ${model}.` },
                        { role: 'user', content: c.prompt }];
    const rootModels = new Map<string, number>();
    for (const e of events) {
      if (e.parent_tool_use_id) continue;
      const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
      if (e.type === 'assistant') {
        const m = e.message?.model; if (m) rootModels.set(m, (rootModels.get(m) ?? 0) + 1);
        let thinking;
        for (const b of blocks) {
          if (b.type === 'thinking') thinking = b.thinking || undefined;
          else if (b.type === 'text' && b.text.trim()) { transcript.push({ role: 'assistant', content: b.text, thinking }); thinking = undefined; }
          else if (b.type === 'tool_use') { transcript.push({ role: 'tool_call', name: b.name, content: JSON.stringify(b.input, null, 2), thinking }); thinking = undefined; }
        }
      } else if (e.type === 'user') {
        for (const b of blocks) if (b.type === 'tool_result')
          transcript.push({ role: 'tool_result', content: (typeof b.content === 'string' ? b.content : textOf(b.content)).slice(0, 6000) });
      }
    }
    const spawns = (existsSync(spawnLog) ? readJsonl(spawnLog) : []).map(s => ({ input: s.tool_input ?? {}, tool: s.tool_name, brief: briefOf(s.tool_input ?? {}) }));
    const guard = existsSync(guardLog) ? readJsonl(guardLog) : [];
    const served = [...rootModels.entries()].sort((a, b) => b[1] - a[1]);
    if (served.length > 1) {
      const e: any = new Error(`root served by several models: ${served.map(s => s[0]).join(', ')}`);
      e.failure_class = 'serving_substitution';
      throw e;
    }
    return {
      model: served[0]?.[0] === model || !served.length ? model : served[0][0],
      usage: result.usage, stop_reason: result.subtype === 'success' ? 'end_turn' : result.subtype,
      status: 'ok', transcript, spawns, guard, clone, end: rootChanges(clone, c.commit),
      output: JSON.stringify(spawns.map(s => ({ model: s.input.model ?? null, type: s.input.subagent_type, description: s.input.description })), null, 2),
      perf: { turns: result.num_turns, cli_cost_usd: result.total_cost_usd, guard_denials: guard.filter(g => g.deny).length },
    };
  } finally {
    // The prefix and the fork are eval artifacts, not sessions: keep them out of
    // the transcript corpus that chat-history and retro scan.
    rmSync(projDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

// Every spawn is denied, so whatever the clone and its worktrees hold at the end
// is the root's own work, however it was written: Edit, a heredoc, `sed -i`, or
// a `git commit`.
export function rootChanges(clone: string, base: string) {
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const trees = git(clone, 'worktree', 'list', '--porcelain').split('\n')
    .filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length));
  const dirty: string[] = [], heads: string[] = [];
  for (const t of trees) {
    try {
      heads.push(git(t, 'rev-parse', 'HEAD').trim());
      for (const l of git(t, 'status', '--porcelain').split('\n').filter(Boolean))
        dirty.push(t === clone ? l.slice(3) : `${t}: ${l.slice(3)}`);
    } catch {} // a worktree the root already removed
  }
  const commits = +git(clone, 'rev-list', '--count', '--all', ...heads, '--not', base).trim();
  return { dirty, commits };
}

// A brief is the spawn prompt plus any brief file it points the worker at.
function briefOf(input: Record<string, any>): string {
  let t = String(input.prompt ?? '');
  for (const p of new Set(t.match(/\/(?:private\/)?tmp\/[^\s'"`)]+\.(?:md|txt)/g) ?? []))
    try { t += `\n\n[${p}]\n` + readFileSync(p, 'utf8').slice(0, 20000); } catch {}
  return t;
}

const NO_COMMIT = /\b(do not|don't|never|no)\s+(git\s+)?commit|\bnot commit\b|\bcommit nothing\b|\bwithout committing\b|\bleave (the |all |your )?(changes |edits |work )?uncommitted\b|\bno git (state )?changes\b|\bno commits\b/i;

export function role(sp: Spawn): 'read' | 'commit' | 'impl' | 'other' {
  const type = sp.input.subagent_type ?? '';
  if (/^(Explore|Plan|claude-code-guide|statusline-setup)$/.test(type)) return 'read';
  // The description's leading verb is the root's own label for the role; trust it first.
  const desc = String(sp.input.description ?? '').trim();
  if (/babysit/i.test(desc)) return 'other';
  if (/^(commit|split .{0,40}commits|create (atomic )?commits)\b/i.test(desc)) return 'commit';
  if (/^((independent|opus|final|third) )?(re-?)?(review|verify|scout|research|map|quantify|audit)\b/i.test(desc)) return 'read';
  const head = `${desc}\n${sp.brief}`.slice(0, 1500);
  if (/\b(committer|commit-only|atomic commits|split .{0,40}into .{0,10}commits)\b/i.test(head)
      && !/\bimplement(er)?\b/i.test(head.slice(0, 400))) return 'commit';
  if (/\bread-only\b|\breview(er)?\b|\baudit\b|\bresearch\b|\bscout\b/i.test(head.slice(0, 600))
      && !/write-enabled|implementer/i.test(head.slice(0, 600))) return 'read';
  return 'impl';
}
// A spawn with no model override, or a fork, runs on the root's own model.
const spawnModel = (sp: Spawn, rootModel: string) =>
  sp.input.subagent_type === 'fork' ? rootModel : String(sp.input.model ?? rootModel);
const isOpus = (m: string) => /opus|fable|best/i.test(m);

function workspaceOf(brief: string): string | undefined {
  const m = brief.match(/(?:workspace|worktree|work only inside|working directory|cwd)[^\n]{0,80}?(\/(?:private\/)?(?:tmp|Users)\/[\w.\/@-]+)/i);
  return m?.[1]?.replace(/[.,;:)]+$/, '');
}
const PATH = /[\w@-]+(?:\/[\w.@*-]+)+|[\w-]+\.(?:rs|ts|tsx|js|mjs|md|py|toml|json|yaml|yml|sh|go)\b/g;
const FIELD = /^\W*([A-Z][\w ]{0,30}?)\W*:/;
// An `Ownership:` field (common contract) is the worker's own paths, read up to
// the next field or blank line. Briefs without one fall back to ownership words,
// skipping lines about siblings: v1's briefs list the packages beside a worker,
// and their paths read as overlapping ownership.
function ownedPaths(brief: string): Set<string> {
  const lines = brief.split('\n');
  const field: string[] = [];
  let inField = false;
  for (const l of lines) {
    const f = l.match(FIELD)?.[1];
    if (f) inField = /^ownership$/i.test(f.trim());
    else if (!l.trim()) inField = false;
    if (inField) field.push(l);
  }
  const owned = field.length ? field
    : lines.filter(l => /\b(own|owns|ownership|only (edit|touch|change))\b/i.test(l) && !/\bsiblings?\b/i.test(l));
  return new Set(owned.flatMap(l => l.match(PATH) ?? []));
}

/** Score the recorded spawns against the case's labelled packages. */
export async function gradeCase(c: Case, run: Run, _ref?: string | null, _ctx?: unknown) {
  const impl: Spawn[] = run.spawns.filter((sp: Spawn) => role(sp) === 'impl');
  const n = impl.length;
  const models = impl.map(sp => spawnModel(sp, run.model));
  const nOpus = models.filter(isOpus).length;
  const split_ok = n === c.start ? 1 : 0;
  const coverage = c.start ? Math.min(n, c.start) / c.start : 0;
  const tier_ok = c.user_model
    ? (models.every(m => m.includes(c.user_model)) ? 1 : 0)
    : (nOpus <= c.opus_ok ? 1 : 0);
  const soloEdits = run.transcript.filter(t => t.role === 'tool_call' && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(t.name))
    .map(t => { try { return JSON.parse(t.content).file_path ?? ''; } catch { return ''; } })
    .filter(p => p.startsWith(run.clone + '/'));
  const dirty: string[] = run.end?.dirty ?? [], rootCommits: number = run.end?.commits ?? 0;
  const solo_ok = soloEdits.length || dirty.length || rootCommits ? 0 : 1;
  const commit_withheld = n ? (impl.every(sp => NO_COMMIT.test(sp.brief)) ? 1 : 0) : null;
  let disjoint_ok: number | null = null, disjointWhy = 'fewer than two implementers';
  if (n > 1) {
    const ws = impl.map(sp => workspaceOf(sp.brief));
    if (ws.every(Boolean) && new Set(ws).size === n) { disjoint_ok = 1; disjointWhy = `distinct workspaces: ${ws.join(', ')}`; }
    else {
      const owned = impl.map(sp => ownedPaths(sp.brief));
      const overlap = owned.some((a, i) => owned.some((b, j) => j > i && [...a].some(p => b.has(p))));
      const empty = owned.some(s => !s.size);
      disjoint_ok = !overlap && !empty ? 1 : 0;
      disjointWhy = empty ? 'a brief names neither its own workspace nor owned paths' : overlap ? 'owned paths overlap' : 'owned paths are disjoint';
    }
  }
  return {
    grade: { split_ok, tier_ok, coverage, solo_ok, commit_withheld, disjoint_ok },
    explanation: {
      split_ok: `${n} implementer(s) launched, expected ${c.start} (${c.shape}, ${c.packages} package(s)); roles: ${run.spawns.map(role).join(', ') || 'no spawns'}`,
      tier_ok: c.user_model ? `user asked for ${c.user_model}; implementer models: ${models.join(', ')}` : `${nOpus} Opus implementer(s), ${c.opus_ok} allowed (startable packages with an open decision); models: ${models.join(', ') || 'none'}`,
      solo_ok: solo_ok ? 'root edited no project files'
        : [soloEdits.length && `root edited ${soloEdits.length} file(s) with edit tools: ${soloEdits.slice(0, 3).join(', ')}`,
           dirty.length && `${dirty.length} changed path(s) at the end: ${dirty.slice(0, 3).join(', ')}`,
           rootCommits && `root made ${rootCommits} commit(s)`].filter(Boolean).join('; '),
      commit_withheld: n ? impl.map(sp => NO_COMMIT.test(sp.brief) ? 'withheld' : `no commit ban in "${sp.input.description}"`).join('; ') : 'no implementers',
      disjoint_ok: disjointWhy,
    },
  };
}

/** Side-channel perf fields beyond the built-ins (latency_s etc.). */
function perfFrom(run: Run) {
  const impl: Spawn[] = run.spawns.filter((sp: Spawn) => role(sp) === 'impl');
  return { ...run.perf, n_impl: impl.length, n_opus_impl: impl.map(sp => spawnModel(sp, run.model)).filter(isOpus).length, n_spawns: run.spawns.length };
}

// --- harness (you usually won't need to touch below this line) --------------

function parseArgs(argv) {
  const a = { flow: '.claude/hillclimb/flow', variant: 'baseline',
              model: undefined, reps: 1, concurrency: 4, timeoutS: 1800,
              approveHarness: false };
  // A flag at the end of argv would otherwise consume undefined - which for
  // --model equals the default and silently disables the served-model check.
  const val = (i) => { if (argv[i] === undefined) { eprint(`missing value for ${argv[i - 1]}`); usage(); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--flow') a.flow = val(++i);
    else if (k === '--variant') a.variant = val(++i);
    else if (k === '--model') a.model = val(++i);
    else if (k === '--reps') a.reps = +val(++i);
    else if (k === '--concurrency') a.concurrency = +val(++i);
    else if (k === '--timeout-s') a.timeoutS = +val(++i);
    else if (k === '--approve-harness') a.approveHarness = true;
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { eprint(`unknown argument: ${k}`); usage(); process.exit(2); }
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) {
    // The report only reads directories named 'baseline' or 'v<N>' - any other
    // name runs to completion but spends the pass into a directory the Summary,
    // trajectory, and budget arithmetic never see.
    eprint(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
    usage(); process.exit(2);
  }
  if (!Number.isFinite(a.timeoutS) || a.timeoutS < 0
      || a.timeoutS * 1000 > 2147483647 // setTimeout clamps >2^31-1 ms to 1 ms - the ceiling would fire instantly
      || !Number.isInteger(a.reps) || a.reps < 1
      || !Number.isInteger(a.concurrency) || a.concurrency < 1) { usage(); process.exit(2); }
  return a;
}
function usage() {
  eprint('usage: bun run-eval.ts --flow DIR --variant ID [--model ID] [--reps N] [--concurrency N] [--timeout-s N (0 = no ceiling)] [--approve-harness]');
}

// Harness integrity gate. The hillclimb loop gets this runner command
// allowlisted for the session and then runs rounds unattended, while the
// per-round change (proposed by an analyzer fed untrusted transcripts) may
// legitimately edit harness code. Without this gate a round that rewrites the
// runner would execute attacker-chosen code on the next unattended run under
// the user's one-time approval. So: sha256 over this file, any lockfile
// beside it or in the directory the runner is invoked from (dependency drift
// is harness drift too; with neither, a note says so), plus
// every path in `_state.json.harness_paths` (relative to the directory the
// runner is invoked from, i.e. the repo root); compare to
// `_state.json.harness_sha`; refuse on absent/mismatch unless a human passes
// --approve-harness, which records the new sha. That write is the one
// sanctioned exception to "never write _state.json".
//
// Scope, stated plainly: this is a change detector, not a security boundary.
// The sha, the path list and this file all live where the loop agent can
// write, so an agent that is already prompt-injected can forge the record or
// pass --approve-harness itself. What it catches is the common case - a
// round's harness edit reaching an unattended run unreviewed - and what
// actually bounds an unattended run is the permission allowlist the user
// grants the runner command (scope it to this exact command line, not a
// prefix). Installed dependencies beyond the lockfile are outside the digest.
function checkHarness(statePath, st, approve) {
  const self = fileURLToPath(import.meta.url);
  const listed = Array.isArray(st.harness_paths) ? st.harness_paths.map(String) : [];
  const lockfiles = [...new Set([dirname(self), process.cwd()].flatMap(d =>
    ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'].map(f => join(d, f))))]
    .filter(f => existsSync(f));
  const paths = [...new Set([self, ...lockfiles, ...listed.map(p => resolve(p))])].sort();
  const h = createHash('sha256');
  const hashed = [];
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); }
    catch (e) {
      if (p === self) throw e;
      eprint(`warning: harness path '${relative(process.cwd(), p)}' not readable (${e?.code || 'error'}) - skipped`);
      continue;
    }
    h.update(relative(process.cwd(), p)).update('\0').update(buf).update('\0');
    hashed.push(relative(process.cwd(), p));
  }
  const sha = h.digest('hex');
  if (st.harness_sha === sha) return;
  // Said only here, where a person is about to approve or is being refused.
  if (!lockfiles.length) eprint('note: no lockfile beside the runner or in the current directory - dependency changes are outside the harness sha');
  if (approve) {
    st.harness_sha = sha;
    writeFileNoFollow(statePath, JSON.stringify(st, null, 2) + '\n');
    eprint(`harness approved: sha256 ${sha.slice(0, 12)} over ${hashed.length} file(s) recorded in ${statePath}`);
    return;
  }
  if (st.harness_sha == null) {
    eprint(`no approved harness sha in ${statePath} (computed ${sha.slice(0, 12)} over: ${hashed.join(', ')}).`);
    eprint('Review the harness, then run once with --approve-harness to record it.');
  } else {
    eprint(`harness changed since last approved run (files: ${hashed.join(', ')}); `
      + `approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
    eprint('Re-run with --approve-harness after reviewing the diff.');
  }
  process.exit(2);
}

// Transient provider errors (429 / overloaded / 5xx) retry with jittered
// exponential backoff - a zero-delay retry loop multiplies cost invisibly
// under rate limits and can turn one transient 429 into a torn-down batch.
// The attempt count lands in the row's meta (or the errors sidecar) so retry
// churn is visible in the data, not just the bill.
async function withBackoff(fn, retry, deadline = Infinity, tries = 5) {
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, not just before sleeps: once the case's
    // ceiling has passed, an abandoned chain must not issue another call
    // (e.g. a judge call after the app call consumed the whole ceiling).
    if (Date.now() >= deadline) {
      const e = new Error('wall-clock ceiling exceeded before attempt');
      e.failure_class = 'timeout';
      throw e;
    }
    try { return await fn(); } catch (e) {
      const status = e?.status ?? e?.response?.status;
      const transient = status === 429 || status === 529 || (status >= 500 && status < 600)
        || /overloaded|rate.?limit/i.test(String(e?.message ?? ''));
      if (!transient || attempt >= tries - 1) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      // Never start a retry that would outlive the case's wall-clock ceiling - 
      // otherwise an abandoned chain keeps issuing API calls after the case failed.
      if (Date.now() + delay >= deadline) throw e;
      retry.count++;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Hard per-case wall-clock ceiling, independent of stream liveness - a hung
// SSE stream can emit keepalives forever, defeating inactivity-based timers.
// The underlying call may keep running; the case fails and the slot is freed.
function withTimeout(promise, seconds, label) {
  if (!(seconds > 0)) return promise;
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: exceeded ${seconds}s wall-clock ceiling`);
      e.failure_class = 'timeout';
      reject(e);
    }, seconds * 1000);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Case ids appear in file paths AND as the row/file join key the report uses,
// so rows, trace filenames, and frozen refs all carry the same path-safe id.
// When sanitization changes the id, a short content hash keeps distinct ids
// distinct ('case/1' vs 'case_1'); the original rides in meta.original_id.
function pathSafeId(id) {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, '_');
  // Idempotent by construction: anything already path-safe and within the
  // length bound - including this function's own truncated+suffixed output - 
  // passes through unchanged. Long ids (URLs, prompt text as id) truncate to
  // 120 chars plus an 8-hex hash of the full original, so they fail here, not
  // at the trace write after the spend, and distinct ids stay distinct.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // lstat("link/") follows the final symlink, so a trailing separator on
  // --flow would blind every leaf isSymlink check below - strip it first.
  // Only Windows treats `\` as a separator; on POSIX it is a filename byte, so
  // splitting on it would walk prefixes that are not real path components.
  args.flow = args.flow.replace(WIN ? /(.)[\\/]+$/ : /(.)\/+$/, '$1');
  const flowSegments = args.flow.split(WIN ? /[\\/]/ : '/');
  // A `.`/`..` segment (e.g. a trailing `/.`) makes isSymlink(args.flow) below
  // resolve a different final component than the named dir - following a
  // planted link at the flow root - while join() collapses it and the absolute
  // branch skips the ancestor walk. Refuse dot segments outright
  // (absolute --flow stays supported).
  if (flowSegments.some(seg => seg === '.' || seg === '..')) {
    eprint(`refusing to run: --flow must not contain '.' or '..' segments, got '${args.flow}'`);
    process.exit(2);
  }
  const vdir = join(args.flow, args.variant);
  // Preflight every output path before the first model call: a planted
  // symlink would otherwise fail each case after its (billed) run.
  for (const p of [args.flow, join(args.flow, 'baseline'), vdir, join(vdir, 'traces'),
                   join(vdir, 'results.jsonl'), join(vdir, 'errors.jsonl'),
                   join(vdir, 'progress.txt'), join(args.flow, 'baseline', 'ref'), join(args.flow, '_state.json')])
    if (isSymlink(p)) { eprint(`refusing to run: ${p} is a symlink (the flow dir must hold regular files)`); process.exit(2); }
  // A relative --flow (the documented `.claude/hillclimb/<name>` layout) is
  // also lstat-walked component by component from the cwd: a pre-planted
  // link at an ancestor (`.claude/hillclimb -> elsewhere`) would otherwise
  // relocate the root capture below - the containment anchor itself - to the
  // attacker's target. An absolute --flow is the caller's own trust decision
  // and is not walked (an absolute ancestor link can be legitimate: /tmp on
  // macOS).
  if (!isAbsolute(args.flow)) {
    let walk = '';
    for (const part of flowSegments.filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(walk)) { eprint(`refusing to run: ${walk} is a symlink (ancestor of --flow)`); process.exit(2); }
    }
  }
  // Every later open/mkdir is bound to this resolved root (see assertInFlow):
  // create the flow dir when fresh (the preflight above refused a link at it
  // and, for a relative path, at every ancestor), then capture where it
  // really resolves.
  mkdirSync(args.flow, { recursive: true });
  flowRealRoot = realpathSync(args.flow);
  mkdirNoFollow(join(vdir, 'traces'));
  // _state.json is READ-ONLY here. The orchestrator owns it. Absent is fine
  // (a baseline-only run has no loop state yet), but present-and-unparsable
  // must not let the id-space gate below pass vacuously over a corrupt file.
  const statePath = join(args.flow, '_state.json');
  let st = {};
  // Read through the no-follow opener like every other flow-dir file; the
  // parse message is not echoed (it can quote the file's first bytes).
  const stateText = readIfPresent(statePath);
  if (stateText != null) {
    try { st = JSON.parse(stateText) || {}; }
    catch { eprint(`${statePath} exists but is not valid JSON - fix it before spending a pass`); process.exit(2); }
  }
  checkHarness(statePath, st, args.approveHarness);
  const ctx = { ...args, state: st };

  // Resume: which (id, rep) pairs already have a row?
  const resultsPath = join(vdir, 'results.jsonl');
  const done = new Set();
  for (const ln of (readIfPresent(resultsPath) ?? '').split('\n')) {
    if (!ln.trim()) continue;
    try { const r = JSON.parse(ln); done.add(`${r.prompt_id}\0${r.rep}`); } catch {}
  }
  // Rows key on the path-safe id (see pathSafeId), so resume must too.

  const cases = await loadCases();
  // Validate the id space before spending anything: duplicate path-safe ids - 
  // including case-insensitive twins, which macOS/Windows filesystems collapse - 
  // would silently overwrite traces and frozen refs; and a _state.json split id
  // that matches no case would silently shrink the scored denominator.
  const seen = new Map();
  for (const c of cases) {
    const k = pathSafeId(c.id).toLowerCase();
    if (seen.has(k)) {
      eprint(`duplicate case id after sanitization: '${c.id}' collides with '${seen.get(k)}'`);
      process.exit(2);
    }
    seen.set(k, c.id);
  }
  const safeIds = new Set(cases.map(c => pathSafeId(c.id)));
  for (const k of ['train_ids', 'val_ids', 'test_ids'])
    if (st[k] != null && !Array.isArray(st[k])) { eprint(`_state.json ${k} must be a list of ids`); process.exit(2); }
  for (const sid of [...(st.train_ids ?? []), ...(st.val_ids ?? []), ...(st.test_ids ?? [])]) {
    const s = String(sid); // the adapter joins with String() on both sides - numeric ids are fine
    if (safeIds.has(s)) continue; // matches a loaded case - definitionally valid
    if (s !== pathSafeId(s)) {
      // Can never match a row: rows key on path-safe ids. This is the silent
      // shrunken-denominator bug - fail before anything is spent.
      eprint(`_state.json split id '${s}' is not a path-safe id - record split ids exactly as they appear in results.jsonl's prompt_id`);
      process.exit(2);
    }
    // Well-formed but absent is legitimate (a trimmed top-K subset run) - note it, don't fail.
    eprint(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
  }
  const refDir = join(args.flow, 'baseline', 'ref');
  const tasks = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) {
    if (done.has(`${pathSafeId(c.id)}\0${rep}`)) continue;
    tasks.push({ c, rep });
  }
  eprint(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);

  let i = 0, ok = 0, fail = 0;
  const errorsPath = join(vdir, 'errors.jsonl');
  // A hard crash (power loss, ENOSPC) can leave a torn final line with no
  // trailing newline; the next append would merge two rows into one permanently
  // unparseable line. Isolate any fragment before appending anything.
  for (const p of [resultsPath, errorsPath]) {
    const tail = readIfPresent(p);
    if (tail && !tail.endsWith('\n')) appendFileNoFollow(p, '\n');
  }
  async function worker() {
    while (i < tasks.length) {
      const { c, rep } = tasks[i++];
      const safeId = pathSafeId(c.id);
      const t0 = Date.now();
      let lastRun = null;    // survives into the catch - billed spend on a failed attempt
      let rowWritten = false; // set once the results row lands - the attempt is scored
      const deadline = args.timeoutS > 0 ? t0 + args.timeoutS * 1000 : Infinity;
      const appRetry = { count: 0 }, judgeRetry = { count: 0 };
      try {
        // One ceiling over the whole case - app call, identity check, and grading - 
        // so a hung judge stream can't hold the slot either.
        const { run, g, latency_s } = await withTimeout((async () => {
          let tAttempt = t0;
          const run = await withBackoff(() => { tAttempt = Date.now(); return runCase(c, ctx); },
            appRetry, deadline);
          lastRun = run;
          // latency_s = the final app attempt only; backoff sleeps, failed
          // attempts, and judge time are excluded (retry counts are in meta).
          const latency_s = (Date.now() - tAttempt) / 1000;
          // Serving identity: fail loudly when the response was served by a model
          // other than the one requested. Accept exact match or a documented
          // alias->snapshot resolution - 'foo-latest'/'foo-0'/'foo' served as
          // 'foo-20250101', 'foo@20250101', or 'foo-2025-01-01'. Anything else - 
          // another snapshot of the requested pin, a sibling model, or the bare
          // base id ('foo-latest' served as 'foo', an unversioned echo that can
          // hide snapshot drift across rounds) - fails the attempt. Non-Anthropic
          // id schemes (e.g. Bedrock's 'anthropic.claude-...-v1:0') need their own
          // rule here.
          if (ctx.model && run.model && run.model !== ctx.model) {
            const base = ctx.model.replace(/-latest$|-0$/, '');
            const rest = String(run.model).startsWith(base)
              ? String(run.model).slice(base.length) : null;
            if (!(rest != null && /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest))) {
              const e = new Error(`served model ${run.model} != requested ${ctx.model}`);
              e.failure_class = 'serving_substitution';
              throw e;
            }
          }
          // Frozen pairwise reference (never regenerated): baseline/ref/<id>.*
          let ref = null;
          if (args.variant !== 'baseline') {
            const p = join(refDir, safeId);
            // A planted symlink throws (ELOOP) rather than feeding the judge
            // its target; the case then fails loudly instead of leaking.
            for (const ext of REF_EXTS) {
              try { ref = readFileNoFollow(p + ext); break; }
              catch (e) { if (e?.code !== 'ENOENT') throw e; }
            }
          }
          const g = await withBackoff(() => gradeCase(c, run, ref, ctx), judgeRetry, deadline);
          return { run, g, latency_s };
        })(), args.timeoutS, `${c.id} rep${rep}`);
        const row = {
          prompt_id: safeId, rep, prompt: c.prompt ?? c.input ?? c.id,
          tags: c.tags, attachments: c.attachments,
          meta: safeId !== String(c.id) || appRetry.count || judgeRetry.count
            ? { ...(c.meta ?? {}),
                ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
                ...(appRetry.count ? { retries: appRetry.count } : {}),
                ...(judgeRetry.count ? { judge_retries: judgeRetry.count } : {}) }
            : c.meta,
          model: run.model, usage: run.usage, stop_reason: run.stop_reason,
          // The report keys on `status`, not stop_reason: a clipped answer is
          // counted and shown but kept out of the means. runCase may set
          // run.status to override the max_tokens rule.
          status: run.status ?? (run.stop_reason === 'max_tokens' ? 'truncated' : 'ok'),
          judge_model: g.judge_model ?? run.judge_model,
          judge_usage: g.judge_usage ?? run.judge_usage,
          latency_s, ...perfFrom(run),
          grade: g.grade, explanation: g.explanation,
        };
        appendFileNoFollow(resultsPath, JSON.stringify(row) + '\n');
        rowWritten = true; // past this point the attempt is scored - a later throw (trace write, ref freeze) must not also append an error row
        if (run.transcript)
          writeFileNoFollow(join(vdir, 'traces', `${safeId}_rep${rep}.json`),
            JSON.stringify(run.transcript, null, 2));
        // For pairwise: on the baseline run, freeze the reference output once.
        if (args.variant === 'baseline' && run.output != null
            && !REF_EXTS.some(ext => lexists(join(refDir, safeId) + ext))) {
          mkdirNoFollow(refDir);
          writeFileNoFollow(join(refDir, safeId),
            typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        }
        ok++;
      } catch (e) {
        fail++;
        if (rowWritten) {
          // The attempt scored; only a post-row write (trace, ref) failed. An error
          // row here would double-count the billed usage under the budget rule.
          eprint(`  [${args.variant}] ${c.id} rep${rep} scored, but a post-row write failed: ${e?.message || e}`);
          continue;
        }
        // Failed attempts are data too - but they must not occupy the (case, rep)
        // slot in results.jsonl, or resume would never re-run them.
        appendFileNoFollow(errorsPath, JSON.stringify({
          prompt_id: safeId, rep,
          ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
          failure_class: e?.failure_class ?? 'error',
          error: String(e?.message || e),
          retries: appRetry.count, judge_retries: judgeRetry.count,
          // Billed-but-failed spend stays countable: when the app call completed
          // before the failure (e.g. a served-model mismatch, a judge-stage
          // ceiling), carry its identity and usage on the error row.
          model: lastRun?.model, usage: lastRun?.usage,
          judge_model: e?.judge_model ?? lastRun?.judge_model,
          judge_usage: e?.judge_usage ?? lastRun?.judge_usage,
          latency_s: (Date.now() - t0) / 1000,
        }) + '\n');
        eprint(`  [${args.variant}] ${c.id} rep${rep} FAILED: ${e?.message || e}`);
      }
    }
  }
  // One progress line every 30s (and to <vdir>/progress.txt) so "how far along
  // is it?" is answerable from the background shell's output or one file read,
  // without the orchestrator parsing results.jsonl mid-write. ETA is a plain
  // rate extrapolation from this pass.
  const t0 = Date.now();
  const progress = () => {
    const done = ok + fail, total = tasks.length;
    const el = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((el / done) * (total - done)) : null;
    const line = `[${args.variant}] ${done}/${total} done (${ok} ok, ${fail} failed), `
      + `${Math.round(el)}s elapsed` + (eta != null ? `, ~${eta}s left` : '');
    eprint(line);
    try { writeFileNoFollow(join(vdir, 'progress.txt'), line + '\n'); } catch {}
  };
  const tick = setInterval(progress, 30_000);
  workersStarted = true;
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  clearInterval(tick); progress();
  eprint(`[${args.variant}] done - ${ok} ok, ${fail} failed -> ${resultsPath}`);
  process.exit(fail ? 1 : 0);
}

// Anything main() throws prints as one sanitized line, not a raw stack. Before
// the workers start it is a refusal (a planted link at _state.json or
// results.jsonl, an lstat that fails, an error from loadCases) and exits 2 like
// the preflight refusals. After they start, only a failed errors.jsonl append
// gets here; rows may already be on disk, so say that and exit 1.
let workersStarted = false;
if (import.meta.main) main().catch(e => {
  const m = String(e?.message || e);
  if (workersStarted) { eprint('stopped mid-run (rows already written are kept; re-run to resume): ' + m); process.exit(1); }
  eprint(m.startsWith('refusing to ') ? m : 'refusing to run: ' + m);
  process.exit(2);
});
