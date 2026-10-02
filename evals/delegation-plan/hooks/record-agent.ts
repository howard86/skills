#!/usr/bin/env bun
// PreToolUse hook for the delegation-plan eval: append each spawn attempt to
// $EVAL_SPAWN_LOG and deny it, so the replayed root's delegation plan is
// recorded without any worker running.
import { appendFileSync } from "node:fs";

const log = process.env.EVAL_SPAWN_LOG;
if (!log) {
  console.error("record-agent: EVAL_SPAWN_LOG unset");
  process.exit(2);
}
appendFileSync(log, (await Bun.stdin.text()).trim() + "\n");
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "EVAL HARNESS: this spawn was recorded, not launched. Do not do its work yourself and do not retry it. " +
      "If your plan launches other workers now, alongside this one, launch them. Anything that would wait for " +
      "this worker's result belongs to a later turn: end your turn instead with a short summary of the delegation plan.",
  },
}));
