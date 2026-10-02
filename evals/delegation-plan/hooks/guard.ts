#!/usr/bin/env bun
// PreToolUse guard for the delegation-plan eval. The replayed root remembers
// the real repo paths from its transcript, so every write it attempts outside
// the throwaway clone and the temp dirs is denied, and so is every tool that
// reaches outside this machine's scratch space (messages, artifacts, pushes).
// Each decision is appended to $EVAL_GUARD_LOG for the trace.
import { appendFileSync } from 'node:fs';

type HookInput = { tool_name: string; tool_input?: Record<string, any> };
const input: HookInput = JSON.parse(await Bun.stdin.text());
const clone = process.env.EVAL_CLONE_DIR;
const allowed = [clone, '/private/tmp/', '/tmp/', '/private/var/folders/'].filter((p): p is string => !!p);
const inside = (p: string) => allowed.some(a => p === a.replace(/\/$/, '') || p.startsWith(a.endsWith('/') ? a : a + '/'));

const BLOCKED_TOOLS = /^(SendMessage|PushNotification|RemoteTrigger|CronCreate|CronDelete|ScheduleWakeup|Monitor|Artifact|ArtifactComments|ArtifactData|SendUserFile|DesignSync|mcp__claude_ai_.*|mcp__agent-bridge__(SendMessage|StopAgent))$/;
// Plans published as a claude.ai artifact or doc reach the root through these.
const READ_ONLY_REMOTE = /^mcp__claude_ai_Claude_Docs__(guide|read|query)$/;

// Bash writes are left to the sandbox (cwd and temp only, no opt-out): a
// command-text heuristic here denied reads like `git branch --show-current`
// and `2>/dev/null`, and every false deny steers the root off its real path.
function decide(): string | null {
  const { tool_name: tool, tool_input: ti = {} } = input;
  if (tool === 'Artifact' && ['read', 'list'].includes(ti.action)) return null;
  if (READ_ONLY_REMOTE.test(tool)) return null;
  if (BLOCKED_TOOLS.test(tool)) return `${tool} reaches outside the eval sandbox`;
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) {
    const p = ti.file_path ?? ti.notebook_path ?? '';
    if (!inside(p)) return `write outside the eval clone: ${p}`;
  }
  if (tool === 'Bash') {
    if (ti.dangerouslyDisableSandbox) return 'unsandboxed Bash is disabled in the eval';
    // -p ends the session when the turn ends, so a background wait is never
    // resumed and the delegation decision after it would go unrecorded.
    if (ti.run_in_background) return 'background commands are unavailable in the eval; run it in the foreground';
    // The sandbox's network allowlist merges with the user's own and let
    // api.github.com through in testing, so publication is refused here.
    const cmd = String(ti.command ?? '');
    if (/(^|[\s;&|(])gh\s/.test(cmd)) return 'gh is disabled in the eval';
    if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) return 'git push is disabled in the eval';
  }
  return null;
}

const reason = decide();
try {
  appendFileSync(process.env.EVAL_GUARD_LOG ?? '/dev/null',
    JSON.stringify({ tool: input.tool_name, deny: reason, input: input.tool_input }) + '\n');
} catch {}
if (reason)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: `EVAL HARNESS: ${reason}. Work only inside ${clone}.` } }));
