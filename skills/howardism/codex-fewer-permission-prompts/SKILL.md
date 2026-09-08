---
name: codex-fewer-permission-prompts
description: Analyze recent Codex transcripts and add narrow, read-only command prefix rules that reduce repeated approval prompts.
disable-model-invocation: true
---

# Codex Fewer Permission Prompts

Reduce repeated Codex approval prompts without widening execution authority unnecessarily.

## Workflow

1. Inventory the 50 most recently modified `*.jsonl` files under `~/.codex/sessions/` and `~/.codex/archived_sessions/`.
2. Read `response_item` tool calls. Include:
   - direct `exec_command` calls whose arguments set `sandbox_permissions` to `require_escalated`;
   - `functions.exec` calls that invoke `tools.exec_command` with the same setting;
   - MCP/app tool names beginning with `mcp__`, for reporting only.
3. For each escalated command, split simple compound commands into their component argv prefixes. Treat redirection, expansion, variables, globs, control flow, or shell wrappers conservatively; do not recommend a rule when parsing is uncertain.
4. Count the command plus its first meaningful subcommand, such as `git fetch`, `gh pr view`, or `cargo test`. Keep only commands that are demonstrably read-only or refresh remote metadata without changing the working tree.
5. Exclude:
   - writes, deletes, renames, installs, pushes, merges, deployments, and destructive actions;
   - shells and shell wrappers;
   - interpreters, evaluators, package runners, and arbitrary-code runners;
   - broad task-runner prefixes such as `cargo`, `make`, `npm run`, or `bun run`;
   - `gh api`, `docker run`/`exec`, `kubectl exec`, `sudo`, and similarly powerful prefixes;
   - commands already covered by `~/.codex/rules/*.rules` or that did not request escalation.
6. Prefer the narrowest argv prefix that covers observed variants. A union is acceptable only for sibling read-only subcommands with the same risk, for example `["git", ["fetch", "ls-remote"]]`.
7. Drop candidates seen fewer than 3 times and cap the result at 20, ranked by count.
8. Present the candidates before editing:

   | # | Prefix rule | Count | Notes |
   | --- | --- | --- | --- |

   Report MCP/app frequencies separately. Do not add them to `.rules`; Codex prefix rules apply to shell commands only.
9. Merge approved candidates into `~/.codex/rules/default.rules`. Preserve existing rules and ordering. Each new `prefix_rule` must include:
   - `decision="allow"`;
   - a short `justification`;
   - observed `match` examples;
   - at least one nearby mutating or over-broad `not_match` example.
10. Validate the full file and every new rule with `codex execpolicy check --pretty --rules ~/.codex/rules/default.rules -- <argv>`. Check both positive and negative examples. Remove any rule that is invalid, over-broad, or ambiguous.
11. Report what was added, what was already covered, and what was skipped for safety.

Never add `prompt` or `forbidden` rules. Never edit any other Codex setting.
