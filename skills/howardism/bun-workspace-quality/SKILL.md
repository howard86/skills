---
name: bun-workspace-quality
description: "Code-quality stack for Bun + Turborepo monorepos: Biome/ultracite lint, per-workspace tsc, husky pre-commit/pre-push gates, GitHub Actions CI, typos, gitleaks, commitlint, Dependabot. Use when setting up or hardening a repo's developer tooling, CI, type-check, spell-check, secret-scan, or lint stack."
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

## Reuse a sibling migration

When a sibling repo already uses this stack, parameterize and reuse that migration instead of rebuilding it. First record the source repo/commit and target values for: workspace globs, Bun/Node runtimes, generated-code dependencies, base branch, CI test/build toggles, deployment project, required secrets/licenses, and spelling/secret allowlists. Copy only compatible config and workflow structure, substitute those values, preserve target-specific scripts, and verify with the target repo's own cold gates. Never copy lockfiles, deployment IDs, secrets, or repo-specific exceptions.

## Decisions

Each choice carries its own gotchas and its own exit condition, so you can read one bullet and know everything about that tool.

- **Biome+ultracite only**, dropping ESLint+Prettier — one source of truth, already integrated with husky, much faster. Costs a few Next/React-specific ESLint plugin rules.
  *Deviate:* a team repo with strong existing ESLint rules keeps ESLint and drops Biome. Running both is worse than either.
- **Per-workspace `tsc --noEmit`**, not project references — cleaner with turbo caching, no composite/declaration emit needed.
- **Pre-push, not pre-commit, for the slow checks** — catches problems before the remote sees them without taxing every commit, and `--no-verify` bypasses it when you need to.
- **`typos` over `cspell`** — allowlist-based, so a domain-rich repo (fashion, scientific, brand names) doesn't drown in false positives.
  *Deviate:* heavy in-package brand vocabulary is still a `typos` case — extend the allowlist rather than switching to `cspell`.
- **`gitleaks` for secrets**, staged at pre-commit and full-history in CI.
  *Gotchas:* `gitleaks protect --staged` is the pre-commit invocation (staged diff only); `gitleaks detect` is for pre-push and CI (commit range or full history). CI needs full history — `actions/checkout` defaults to `fetch-depth: 1` and gitleaks would scan only the tip, so set `fetch-depth: 0`. Under a GitHub **organization**, gitleaks-action v2 needs `secrets.GITLEAKS_LICENSE` or the step fails; personal and public repos run fine without it.
- **Dependabot over Renovate** — built-in to GitHub, zero external service, at the price of per-package PR noise. (User preference; Renovate is more configurable.)
  *Gotcha:* Bun ecosystem support is partial. If `package-ecosystem: bun` doesn't honor `bun.lock`, fall back to `package-ecosystem: npm` against `package.json` — Dependabot then updates `package.json` but not the lockfile, so run `bun install` locally before merging. Verify on the first PR.
  *Deviate:* solo project with low PR volume — skip it and run `bun outdated` quarterly.
- **`bun test` over Vitest** — native, zero extra dep, fastest for Bun-runtime code.
  *Gotcha:* jsdom/RTL is rougher here. This is the right pick only if web tests stay light; revisit if web-app testing becomes substantial, where Vitest is safer.
- **CI via the shared [`howard86/actions`](https://github.com/howard86/actions) repo**, not hand-rolled steps — one SHA-pinned source of truth for the `checkout`/`setup-bun`/`typos`/`gitleaks`/`actionlint` versions, bumped once and propagated by Dependabot instead of re-pinned in every repo's `ci.yml`. Adopt the reusable workflow wholesale, or use the `setup`/`quality` composites à la carte.
  *Gotchas:* pin to a SHA with a `# vX.Y.Z` comment, never a moving tag — that is what the actions repo is built around and what the `github-actions` Dependabot ecosystem bumps. The workflow expects root `check`/`typecheck`/`test`/`build` scripts, but the `test`/`build` steps are `if`-guarded, so keep those toggles false until the scripts exist. `actionlint` runs as a gate inside `quality`, so malformed workflow YAML fails the run — usually a feature, occasionally a surprise when hand-editing.
  *Deviate:* if a merge must guarantee a green build, flip `run-build: true` (or scope it to main with `${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`) — adds 2-3 min and needs a root `build` script. If you can't depend on `howard86/actions` at all (different org, air-gapped, zero external action deps), inline what the reusable workflow runs — `checkout` (`fetch-depth: 0`) → `setup-bun` → Turbo/Bun caches → frozen install → `check` → `typos` → `gitleaks` → `typecheck` — pinning each third-party SHA yourself.

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
10. **Verify cold, then open the PR.** Turbo caching masks tsconfig problems once warm, so a green local run proves nothing until the cache is gone. The rollout is done when all four hold:
    - `rm -rf .turbo && bun x turbo run typecheck` passes from cold.
    - `bun run check` passes across every workspace.
    - All three husky hooks fire on a throwaway commit — pre-commit (lint-staged + `gitleaks protect`), commit-msg (rejects a non-conventional message), pre-push (the full slow gate).
    - CI is green on the rollout PR itself, `actionlint` included.

    Anything still red here is the rollout's problem, not the next PR's.

## Vercel deployment policy

- Pushes to PR branches produce Vercel Preview deployments.
- Merging to `main` produces the Vercel Production deployment.
- Use the Vercel CLI to link/configure the project and audit deployments/settings. Do not run a CLI production deployment (`vercel --prod` or equivalent) unless the user explicitly requests that production action.
