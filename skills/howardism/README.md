# Howardism

Skills I wrote myself — they have no counterpart in the upstream fork.

## User-invoked

Reachable only by typing the name.

- **[refine-skill](./refine-skill/SKILL.md)** — Refine an existing skill by testing it against the live harness and its usage history before editing any prose.
- **[refine-harness](./refine-harness/SKILL.md)** — Prune, relocate, and sharpen the always-on harness config (global CLAUDE.md, rules-engine rules, hooks, auto-memory, skill listing, permissions, mirrors) against Anthropic's guidance and the last 30 days of evidence.
- **[blindspot](./blindspot/SKILL.md)** — Diagnosis-only pass over a stated goal that surfaces the unknown unknowns, ranked by leverage, plus sharper follow-up prompts. Never edits.
- **[perf-review](./perf-review/SKILL.md)** — Fan out the perf-* angle skills as parallel subagents over a target and merge their findings into ranked, measurable improvement suggestions.
- **[codex-fewer-permission-prompts](./codex-fewer-permission-prompts/SKILL.md)** — Mine recent Codex transcripts for repeated read-only approvals and add narrow prefix rules for them.

## Model-invoked

Model- or user-reachable (rich trigger phrasing so the model can reach for them).

- **[codex-refine-harness](./codex-refine-harness/SKILL.md)** — Review and diagnose global Codex AGENTS.md, then apply authorized improvements; global CLAUDE.md is a read-only reference.
- **[afk-issue-loop](./afk-issue-loop/SKILL.md)** — Autonomously burn down a GitHub issue backlog into one PR per issue — claim, branch, implement, verify, open PR; never merges. Bundles a resumable headless runner and documents the `/loop` + cron orchestration paths.
- **[bun-workspace-quality](./bun-workspace-quality/SKILL.md)** — Code quality toolkit for Bun + Turborepo monorepos — Biome/ultracite lint, per-workspace typecheck, husky pre-commit/pre-push gates, GitHub Actions CI, typos, gitleaks, commitlint, Dependabot.
- **[find-skills](./find-skills/SKILL.md)** — Discover and install skills from the open agent-skills ecosystem.
- **[chat-history](./chat-history/SKILL.md)** — Search and replay past Claude Code transcripts and Codex rollouts from one bundled CLI.
- **[implement-with-subagent](./implement-with-subagent/SKILL.md)**: Delegate an approved plan using the running harness’s subagent reference, then verify and integrate the result.
- **[commit-with-subagent](./commit-with-subagent/SKILL.md)**: Delegate scoped atomic commits; verify before any requested push or draft PR.
- **[subagent-routing](./subagent-routing/SKILL.md)**: Resolve native delegation or an authorized Agent Bridge route, with supported models and clear ownership.
- **[rebase-babysit](./rebase-babysit/SKILL.md)** — Rebase a stale PR onto its base, resolve conflicts, force-push, then babysit reviews and CI through to merge-ready.
- **[retro](./retro/SKILL.md)** — Mine past session transcripts for recurring prompts and friction, then propose skills, rules, and memories that would remove them.
- **[perf-measurement](./perf-measurement/SKILL.md)** — Estimate and measure performance: back-of-envelope costing from a latency-numbers table, microbenchmarks, profiling.
- **[perf-algorithms](./perf-algorithms/SKILL.md)** — Find algorithmic wins in a hot path: complexity reduction, fast paths, precomputing, deferring, caching.
- **[perf-memory](./perf-memory/SKILL.md)** — Cut allocation and memory-representation costs: pre-sizing, copy avoidance, object reuse, compact layouts, indices over pointers.
- **[perf-api](./perf-api/SKILL.md)** — Performance-aware interface shape: bulk operations, view parameters, thread-compatible defaults, hoisted per-call setup.
- **[perf-overhead](./perf-overhead/SKILL.md)** — Strip incidental hot-path overhead: logging, stats collection, and indirection the optimizer can't see through.
