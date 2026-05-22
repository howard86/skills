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

Build is **not** in CI — trust Vercel/host preview deploys (the shared CI workflow runs with `run-build: false`).

## Why these choices (short)

- **Biome+ultracite only**, dropping ESLint+Prettier: one source of truth, already integrated with husky, much faster. Lose a few Next/React-specific ESLint plugin rules.
- **Per-workspace `tsc --noEmit`** (not project references): cleaner with turbo caching, no composite/declaration emit needed.
- **Pre-push** (not pre-commit) for the slow checks: catches before remote sees it, doesn't slow each commit, bypassable with `--no-verify`.
- **`typos` over `cspell`**: allowlist-based, won't drown a domain-rich repo (fashion, scientific, brand names) in false positives.
- **Dependabot over Renovate**: built-in to GitHub, zero external service; accept the per-package PR noise. (User preference; Renovate would be more configurable.)
- **`bun test` over Vitest**: native, zero extra dep, fastest for Bun-runtime code. Pick this only if web tests will be light; Vitest is the safer pick if there's heavy React/jsdom testing.
- **CI via the shared [`howard86/actions`](https://github.com/howard86/actions) repo**, not hand-rolled steps: one SHA-pinned source of truth for the `checkout`/`setup-bun`/`typos`/`gitleaks`/`actionlint` versions, bumped once and propagated by Dependabot, instead of re-pinning them in every repo's `ci.yml`. Adopt the reusable workflow wholesale, or use the `setup`/`quality` composites à la carte.

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
5. **Typos config (optional).** The `quality` action ships a bundled default and auto-detects a repo-local `_typos.toml`/`typos.toml`/`.typos.toml`. Add one only for domain vocab: `[default.extend-words]` plus `[files] extend-exclude = ["bun.lock", "*.svg", "**/staging/**", "node_modules", ".next", "dist"]`.
6. **Gitleaks config (optional).** Same pattern — bundled default, auto-detects repo-local `.gitleaks.toml`/`gitleaks.toml`. Add one only to allowlist `.env.example` and known fixture values.
7. **CI workflow** — `.github/workflows/ci.yml` calls the shared reusable workflow. SHA-pin with a `# vX.Y.Z` comment (Dependabot bumps it):
   ```yaml
   name: CI
   on:
     push: { branches: [main] }
     pull_request: { branches: [main] }
   jobs:
     ci:
       uses: howard86/actions/.github/workflows/ci.yml@<sha> # v1.0.0
       permissions:
         contents: read
       with:
         run-test: false    # flip true once the first test exists
         run-build: false   # build stays out of CI (preview deploys cover it)
       secrets:
         gitleaks-license: ${{ secrets.GITLEAKS_LICENSE }}   # only needed for org accounts
   ```
   Requires root scripts `check` + `typecheck` (and `test`/`build` only when their toggles are on). Set `node-version: "24"` if a workspace needs Node; `working-directory` for a nested package.
   **Complex/multi-job repo:** skip the reusable workflow and compose à la carte — `actions/checkout@<sha>` (`fetch-depth: 0`) → `howard86/actions/setup@<sha>` → your `check`/`typecheck` `run:` steps → `howard86/actions/quality@<sha>` with `github-token: ${{ secrets.GITHUB_TOKEN }}`.
8. **Dependabot** — `.github/dependabot.yml`, weekly. Two ecosystems: `npm` (grouped `dev-dependencies`/`production-dependencies`, ignore majors for `react`/`next`/`prisma`) **and `github-actions`** so the SHA-pinned `howard86/actions` ref auto-bumps from each `vX.Y.Z` release. See watch-points.
9. **Docs** — short section in README/AGENTS.md: what runs at each gate, how to bypass (`--no-verify`), how to install binaries locally (`brew install typos-cli gitleaks`).

## Watch-points

- **Dependabot + `bun.lock`**: Dependabot's Bun ecosystem support is partial. If `package-ecosystem: bun` doesn't honor `bun.lock` on your repo, fall back to `package-ecosystem: npm` pointing at `package.json` — Dependabot updates `package.json` but not the lockfile; you run `bun install` locally before merging. Verify on first PR.
- **First cold pre-push**: turbo caching masks tsconfig issues once warm. Before opening the rollout PR run `rm -rf .turbo && bun x turbo run typecheck` to verify cold state.
- **Gitleaks in CI needs full history**: default `actions/checkout` fetches `fetch-depth: 1`; gitleaks will only scan the tip. Set `fetch-depth: 0`.
- **`gitleaks protect --staged`** is the right invocation for pre-commit (only staged diff). `gitleaks detect` is for pre-push and CI (commit range or full history).
- **`bun test` vs Vitest** decision: revisit if web app testing becomes substantial; jsdom/RTL is rougher in `bun test`.
- **gitleaks-action v2 needs a license for org accounts.** Personal/public repos run fine without; under a GitHub **organization** set `secrets.GITLEAKS_LICENSE` or the gitleaks step fails. (The `quality` action / reusable workflow pass it through but don't require it.)
- **Reusable workflow expects `check`/`typecheck`/`test`/`build` root scripts**, but the `test`/`build` steps are `if`-guarded — keep `run-test`/`run-build` false until those scripts exist, then flip them. `check` + `typecheck` always run.
- **Pin `howard86/actions` to a SHA with a `# vX.Y.Z` comment**, never a moving tag — that's what the actions repo is built around and what the `github-actions` Dependabot ecosystem bumps.
- **`actionlint` is now a CI gate** (inside `quality`): malformed workflow YAML fails the run. Usually a feature; just be aware when hand-editing workflows.

## When to deviate

- **Team repo with strong existing ESLint rules**: keep ESLint, drop Biome. Don't try to run both.
- **Project requires guaranteed build success on every merge**: flip `run-build: true` (or `run-build: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}` for main-only). Adds ~2-3 min; requires a root `build` script.
- **Domain has heavy in-package brand vocabulary**: still prefer `typos` over `cspell` — extend the allowlist instead.
- **Solo project, low PR volume**: skip Dependabot, run `bun outdated` manually quarterly.
- **Can't depend on `howard86/actions`** (different org, air-gapped, or you want zero external action deps): inline the steps the reusable workflow runs — `checkout` (`fetch-depth: 0`) → `setup-bun` → Turbo/Bun caches → frozen install → `check` → `typos` → `gitleaks` → `typecheck` — and pin each third-party action's SHA yourself.
