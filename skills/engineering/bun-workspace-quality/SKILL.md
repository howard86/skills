---
name: bun-workspace-quality
description: Code quality toolkit for Bun + Turborepo monorepos. Biome+ultracite lint, per-workspace tsc typecheck, husky pre-commit/pre-push/commit-msg gates, GitHub Actions CI, typos spell-check, gitleaks secret scan, commitlint, Dependabot. Use when setting up or hardening developer tooling in a Bun workspace / Turborepo monorepo, or when the user asks for CI / type-check / spell-check / secret-scan / lint-stack setup in such a repo.
---

# Bun Workspace Quality Toolkit

The decided stack for a Bun + Turborepo monorepo and the order to roll it out. Use this as the baseline; deviate only with explicit reason.

## The stack at a glance

| Concern | Tool | Where it runs |
|---|---|---|
| Lint + format | Biome via ultracite | pre-commit (staged), pre-push (full), CI |
| Typecheck | `tsc --noEmit` per workspace, orchestrated by turbo | pre-push, CI |
| Spell-check | `typos` (Rust binary, allowlist-based) | pre-push, CI |
| Secrets | `gitleaks` | pre-commit (staged), CI (full history) |
| Commit msg | `commitlint` + `@commitlint/config-conventional` | commit-msg hook |
| Deps | Dependabot | weekly PRs |
| Lockfile | `bun install --frozen-lockfile` | CI |
| Tests | `bun test` (chosen, not scaffolded until first test) | n/a until needed |

Build is **not** in CI — trust Vercel/host preview deploys.

## Why these choices (short)

- **Biome+ultracite only**, dropping ESLint+Prettier: one source of truth, already integrated with husky, much faster. Lose a few Next/React-specific ESLint plugin rules.
- **Per-workspace `tsc --noEmit`** (not project references): cleaner with turbo caching, no composite/declaration emit needed.
- **Pre-push** (not pre-commit) for the slow checks: catches before remote sees it, doesn't slow each commit, bypassable with `--no-verify`.
- **`typos` over `cspell`**: allowlist-based, won't drown a domain-rich repo (fashion, scientific, brand names) in false positives.
- **Dependabot over Renovate**: built-in to GitHub, zero external service; accept the per-package PR noise. (User preference; Renovate would be more configurable.)
- **`bun test` over Vitest**: native, zero extra dep, fastest for Bun-runtime code. Pick this only if web tests will be light; Vitest is the safer pick if there's heavy React/jsdom testing.

## Rollout — one PR, atomic commits

Order matters: tsconfig fix must land before typecheck gate turns on.

1. **Converge lint stack.** Delete `packages/config-eslint/`; remove `eslint`, `@*/eslint-config`, `@next/eslint-plugin-next`, `prettier` from all `package.json`; remove per-workspace `lint` scripts; replace root `"lint"` with `"ultracite check"`. Remove the `lint` task from `turbo.json` or leave it empty.
2. **Fix bun-runtime tsconfig** (`apps/cli` or any bun-runtime workspace): `target: ES2022`, `module: Preserve`, `moduleResolution: Bundler`, `types: ["bun"]`, `lib: ["ES2023"]`. Verifies clean `tsc --noEmit`.
3. **Typecheck task.** Add `"typecheck": "tsc --noEmit"` to every workspace. In `turbo.json`:
   ```jsonc
   "typecheck": {
     "dependsOn": ["^typecheck", "^generate"],
     "inputs": ["**/*.{ts,tsx}", "tsconfig.json", "tsconfig.*.json"]
   }
   ```
   The `^generate` dep is required if any package depends on Prisma client output.
4. **Husky gates.**
   - `.husky/pre-commit`: `bun x lint-staged && gitleaks protect --staged --redact`
   - `.husky/pre-push`: `bun run check && bun x turbo run typecheck && typos && gitleaks detect --redact --log-opts="origin/main..HEAD"`
   - `.husky/commit-msg`: `bunx --no-install commitlint --edit "$1"`
   - Add `commitlint.config.js`: `module.exports = { extends: ["@commitlint/config-conventional"] }`
5. **Typos config** — `typos.toml` at root with `[default.extend-words]` for domain terms and `[files] extend-exclude = ["bun.lock", "*.svg", "**/staging/**", "node_modules", ".next", "dist"]`.
6. **Gitleaks config** — `.gitleaks.toml` extending defaults with allowlist for `.env.example` and known fixture values.
7. **CI workflow** — `.github/workflows/ci.yml`:
   - Triggers: `pull_request`, `push: branches: [main]`
   - `actions/checkout@v4` with `fetch-depth: 0` (gitleaks history)
   - `oven-sh/setup-bun@v2` using `bun-version-file: package.json` (reads `packageManager`)
   - `bun install --frozen-lockfile`
   - `bun run check` → `bun x turbo run typecheck` → `typos` → `gitleaks detect --redact`
   - Restore `.turbo/` via `actions/cache` keyed on lockfile + workflow.
8. **Dependabot** — `.github/dependabot.yml`, weekly, grouped `dev-dependencies` and `production-dependencies`, ignore majors for framework anchors (`react`, `next`, `prisma`). See watch-points.
9. **Docs** — short section in README/AGENTS.md: what runs at each gate, how to bypass (`--no-verify`), how to install binaries locally (`brew install typos-cli gitleaks`).

## Watch-points

- **Dependabot + `bun.lock`**: Dependabot's Bun ecosystem support is partial. If `package-ecosystem: bun` doesn't honor `bun.lock` on your repo, fall back to `package-ecosystem: npm` pointing at `package.json` — Dependabot updates `package.json` but not the lockfile; you run `bun install` locally before merging. Verify on first PR.
- **First cold pre-push**: turbo caching masks tsconfig issues once warm. Before opening the rollout PR run `rm -rf .turbo && bun x turbo run typecheck` to verify cold state.
- **Gitleaks in CI needs full history**: default `actions/checkout` fetches `fetch-depth: 1`; gitleaks will only scan the tip. Set `fetch-depth: 0`.
- **`gitleaks protect --staged`** is the right invocation for pre-commit (only staged diff). `gitleaks detect` is for pre-push and CI (commit range or full history).
- **`bun test` vs Vitest** decision: revisit if web app testing becomes substantial; jsdom/RTL is rougher in `bun test`.

## When to deviate

- **Team repo with strong existing ESLint rules**: keep ESLint, drop Biome. Don't try to run both.
- **Project requires guaranteed build success on every merge**: add `bun x turbo run build` to CI step (accept ~2-3 min total).
- **Domain has heavy in-package brand vocabulary**: still prefer `typos` over `cspell` — extend the allowlist instead.
- **Solo project, low PR volume**: skip Dependabot, run `bun outdated` manually quarterly.
