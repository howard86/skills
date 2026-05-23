#!/usr/bin/env bash
#
# issue-loop.sh — drive Claude Code (headless) over open GitHub issues, one at a
# time, producing one branch + one PR per issue.
#
# Each issue is implemented inside a single dedicated git worktree so your main
# checkout is never touched. Claude runs with --dangerously-skip-permissions so
# the loop never blocks on a prompt; work lands as a PR for human review, not a
# merge.
#
# Usage:
#   scripts/issue-loop.sh                          # all open issues, ascending
#   LABEL=ready-for-agent scripts/issue-loop.sh
#   DRY_RUN=1 scripts/issue-loop.sh                # show what would run, do nothing
#   LIMIT=1 scripts/issue-loop.sh                  # process just the first pending issue
#   SKIP_PR=1 scripts/issue-loop.sh                # implement + commit, but don't push/open PR
#
# Resumable: completed issue numbers are recorded in STATE_DIR/done.txt and
# skipped on the next run. Delete that file (or a single line) to re-process.
#
# Env knobs (all optional):
#   REPO            GitHub repo            (default: auto-detect via `gh repo view`)
#   LABEL           filter issues by label (default: empty = all open issues)
#   MODEL           model alias            (default: opus)
#   MAX_BUDGET_USD  per-issue spend cap    (default: 10)
#   LIMIT           max issues this run    (default: 0 = no limit)
#   DRY_RUN         1 = list only          (default: 0)
#   SKIP_PR         1 = no push / no PR    (default: 0)
#   BASE_BRANCH     PR base branch         (default: repo default branch)
#   ENV_FILES       space-separated gitignored env files to copy main→worktree
#                   (e.g. "apps/api/.env packages/db/.env"; default: none)
#   BOOTSTRAP_CMD   one-time worktree setup, run on first run only
#                   (e.g. "bun install && bun run generate"; default: none)
#   DBUP_CMD        best-effort local-service start for tests
#                   (e.g. "bun run db:up"; default: none)
#   WORKTREE_DIR    worktree path          (default: <repo>/.git/issue-loop-wt)
#   STATE_DIR       state + logs           (default: <repo>/.git/issue-loop)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LABEL="${LABEL:-}"
MODEL="${MODEL:-opus}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-10}"
LIMIT="${LIMIT:-0}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_PR="${SKIP_PR:-0}"
BOOTSTRAP_CMD="${BOOTSTRAP_CMD:-}"
DBUP_CMD="${DBUP_CMD:-}"

log()  { printf '\033[1;34m[loop]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[loop]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[loop]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
for bin in claude gh git; do
  command -v "$bin" >/dev/null 2>&1 || { err "missing required binary: $bin"; exit 1; }
done
gh auth status >/dev/null 2>&1 || { err "gh is not authenticated (run: gh auth login)"; exit 1; }

ROOT="$(git rev-parse --show-toplevel)"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
[ -n "$REPO" ] || { err "REPO not set and could not auto-detect — set REPO=owner/name"; exit 1; }
BASE_BRANCH="${BASE_BRANCH:-$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)}"

WORKTREE_DIR="${WORKTREE_DIR:-$ROOT/.git/issue-loop-wt}"
STATE_DIR="${STATE_DIR:-$ROOT/.git/issue-loop}"
LOG_DIR="$STATE_DIR/logs"
DONE_FILE="$STATE_DIR/done.txt"
BOOTSTRAP_MARK="$STATE_DIR/.bootstrapped"   # outside the worktree so per-issue clean can't wipe it

# Split ENV_FILES env string into an array (default empty).
_env_files_str="${ENV_FILES:-}"
read -r -a ENV_FILES <<< "$_env_files_str"

mkdir -p "$STATE_DIR" "$LOG_DIR"
touch "$DONE_FILE"

# ---------------------------------------------------------------------------
# Worktree setup (once)
# ---------------------------------------------------------------------------
setup_worktree() {
  git -C "$ROOT" fetch origin --quiet

  if ! git -C "$ROOT" worktree list --porcelain | grep -qx "worktree $WORKTREE_DIR"; then
    log "creating dedicated worktree: $WORKTREE_DIR"
    git -C "$ROOT" worktree add --detach "$WORKTREE_DIR" "origin/$BASE_BRANCH" >/dev/null
  fi

  # Seed real (gitignored) env files from the main checkout so build gates work.
  for f in "${ENV_FILES[@]}"; do
    [ -z "$f" ] && continue
    if [ -f "$ROOT/$f" ]; then
      mkdir -p "$WORKTREE_DIR/$(dirname "$f")"
      cp "$ROOT/$f" "$WORKTREE_DIR/$f"
    else
      warn "no $f in main checkout — worktree may fail env validation"
    fi
  done

  # One-time bootstrap (deps, codegen). Marker lives in STATE_DIR, which the
  # per-issue `git clean` cannot reach.
  if [ -n "$BOOTSTRAP_CMD" ] && [ ! -f "$BOOTSTRAP_MARK" ]; then
    log "bootstrapping worktree (first run only): $BOOTSTRAP_CMD"
    (cd "$WORKTREE_DIR" && eval "$BOOTSTRAP_CMD") && touch "$BOOTSTRAP_MARK"
  fi

  # Best-effort local service (e.g. a DB) for any tests Claude may run.
  if [ -n "$DBUP_CMD" ]; then
    (cd "$WORKTREE_DIR" && eval "$DBUP_CMD" >/dev/null 2>&1) || warn "DBUP_CMD failed — DB-dependent tests may fail"
  fi
}

# ---------------------------------------------------------------------------
# Per-issue work — returns non-zero on failure but never aborts the loop.
# ---------------------------------------------------------------------------
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40 \
    | sed -E 's/-+$//'
}

process_issue() {
  local n="$1"
  local title body slug branch logfile prompt ahead pr_url pr_body_file pr_body

  title="$(gh issue view "$n" --repo "$REPO" --json title --jq '.title')"
  body="$(gh issue view "$n" --repo "$REPO" --json body --jq '.body')"
  slug="$(slugify "$title")"
  branch="feature/issue-${n}-${slug}"
  logfile="$LOG_DIR/issue-${n}.log"

  log "════════ issue #$n: $title"
  log "branch:  $branch"
  log "log:     $logfile"

  # Already shipped? An issue stays open + labelled until its PR merges, so skip
  # any issue that already has an open PR on a feature/issue-<n>-* branch before
  # spending a budget cycle re-doing it (GOTCHAS #8).
  if gh pr list --repo "$REPO" --state open --json headRefName --jq '.[].headRefName' 2>/dev/null \
       | grep -q "^feature/issue-${n}-"; then
    log "#$n already has an open PR (feature/issue-${n}-*) — skipping (GOTCHAS #8)"
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN — would implement and open a PR for #$n"
    return 0
  fi

  # Fresh branch off the latest base, clean slate (gitignored deps survive).
  git -C "$WORKTREE_DIR" fetch origin --quiet
  git -C "$WORKTREE_DIR" reset --hard --quiet HEAD || true
  git -C "$WORKTREE_DIR" clean -fdq || true
  git -C "$WORKTREE_DIR" checkout -B "$branch" "origin/$BASE_BRANCH" --quiet

  pr_body_file="$STATE_DIR/pr-body-${n}.md"   # absolute, outside the worktree → never committed
  rm -f "$pr_body_file"

  prompt="$(cat <<EOF
You are implementing GitHub issue #${n} in this repository.

Title: ${title}

Issue body:
---
${body}
---

Rules:
- You are already on a fresh branch ('${branch}') checked out from origin/${BASE_BRANCH}. Do NOT switch, create, or delete branches.
- Implement ONLY what this issue asks. Read CLAUDE.md / README / contributing docs if present, match existing style, keep changes surgical.
- If you change anything with generated code (DB schemas, protobufs, OpenAPI specs, ORM models), run the project's codegen step before relying on the regenerated types.
- Before committing, run the project's lint / type-check / test commands (check package.json scripts, Makefile, justfile, or README) and fix any failures you introduce.
- Commit your work as **atomic Conventional Commits** — one self-contained logical change per commit (e.g. schema, then API, then web), not a single mega-commit. Do NOT push and do NOT open a pull request — an external wrapper handles that.
- After committing, write a review-ready PR summary to the file '${pr_body_file}' (an absolute path outside the repo — do NOT commit it; the wrapper reads it). Use these sections: '## What'; '## Decisions' — call out every judgment call or spec ambiguity you resolved and ask the reviewer to sanity-check it, plus any expected merge conflict with a sibling PR on shared files; '## Verification' — which lint/type/test gates you ran, and anything you could NOT verify (e.g. UI not visually checked).
- If the issue is already satisfied, infeasible, or under-specified, make NO commits and end your reply with a line starting 'NO-OP:' explaining why.
EOF
)"

  log "running Claude (model=$MODEL, budget=\$$MAX_BUDGET_USD)…"
  if ! (cd "$WORKTREE_DIR" && claude -p "$prompt" \
        --model "$MODEL" \
        --dangerously-skip-permissions \
        --max-budget-usd "$MAX_BUDGET_USD" 2>&1 | tee "$logfile"); then
    err "Claude exited non-zero for #$n — see $logfile"
    return 1
  fi

  ahead="$(git -C "$WORKTREE_DIR" rev-list --count "origin/$BASE_BRANCH..HEAD")"
  if [ "$ahead" -eq 0 ]; then
    warn "#$n produced no commits (no-op or failed) — skipping PR"
    return 0
  fi
  log "#$n produced $ahead commit(s)"

  if [ "$SKIP_PR" = "1" ]; then
    log "SKIP_PR set — leaving branch '$branch' in worktree, not pushing"
    return 0
  fi

  # Push (pre-push hooks run here) and open the PR.
  if ! git -C "$WORKTREE_DIR" push -u origin "$branch" 2>&1 | tee -a "$logfile"; then
    err "push failed for #$n (pre-push gate?) — see $logfile"
    return 1
  fi

  if gh pr list --repo "$REPO" --head "$branch" --json number --jq '.[0].number' | grep -q '[0-9]'; then
    log "PR already exists for $branch — skipping create"
    return 0
  fi

  # Prefer the model-written summary; fall back to a minimal template.
  if [ -s "$pr_body_file" ]; then
    pr_body="$(printf 'Closes #%s\n\n%s\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' "$n" "$(cat "$pr_body_file")")"
  else
    pr_body="$(printf 'Closes #%s\n\nImplemented by the automated issue-loop (afk-issue-loop skill).\nSee individual commits for details.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' "$n")"
  fi
  rm -f "$pr_body_file"

  pr_url="$(gh pr create --repo "$REPO" \
    --base "$BASE_BRANCH" --head "$branch" \
    --title "$title" \
    --body "$pr_body")"
  log "opened PR: $pr_url"
  return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "repo=$REPO label='${LABEL:-<all>}' model=$MODEL base=$BASE_BRANCH dry_run=$DRY_RUN skip_pr=$SKIP_PR limit=$LIMIT"

mapfile -t ISSUES < <(
  gh issue list --repo "$REPO" --state open --limit 200 \
    ${LABEL:+--label "$LABEL"} \
    --json number --jq 'sort_by(.number) | .[].number'
)

if [ "${#ISSUES[@]}" -eq 0 ]; then
  log "no open issues match — nothing to do"
  exit 0
fi
log "found ${#ISSUES[@]} open issue(s): ${ISSUES[*]}"

[ "$DRY_RUN" = "1" ] || setup_worktree

processed=0
for n in "${ISSUES[@]}"; do
  if grep -qx "$n" "$DONE_FILE"; then
    log "skip #$n (already in $DONE_FILE)"
    continue
  fi
  if [ "$LIMIT" != "0" ] && [ "$processed" -ge "$LIMIT" ]; then
    log "LIMIT=$LIMIT reached — stopping"
    break
  fi

  if process_issue "$n"; then
    [ "$DRY_RUN" = "1" ] || echo "$n" >>"$DONE_FILE"
  else
    warn "#$n failed — NOT marking done; will retry next run"
  fi
  processed=$((processed + 1))
done

log "done — processed $processed issue(s) this run"
