#!/usr/bin/env bash
#
# wait-for-checks.sh — block until a PR's CI run reaches a terminal state, then
# print one summary and exit. Built for `run_in_background`: the whole cycle
# costs a single completion notification instead of one per check.
#
# Usage:
#   scripts/wait-for-checks.sh 1234                     # PR number, URL, or branch
#   EXPECT_SHA=$(git rev-parse HEAD) scripts/wait-for-checks.sh 1234
#   INTERVAL=60 TIMEOUT=3600 scripts/wait-for-checks.sh 1234
#
# Waits for checks to *appear* before judging them: straight after a force-push
# GitHub reports zero checks, and treating that as "all green" is the classic
# false pass. Nothing is called terminal until the check set has been non-empty
# and stable for SETTLE seconds.
#
# Exit codes (the caller's verdict — read them, don't re-derive from stdout):
#   0  terminal, nothing failed        (pass/skipping only)
#   1  terminal, at least one failed   (fail or cancel; names listed on stdout)
#   2  timed out while still pending
#   3  head SHA moved — a new push superseded this run, verdict abandoned
#   4  no checks ever appeared within GRACE seconds
#   5  usage / gh error
#
# Env knobs (all optional):
#   REPO        owner/name for gh      (default: auto-detect from cwd)
#   INTERVAL    seconds between polls  (default: 30)
#   TIMEOUT     max total wait, sec    (default: 2700 = 45m)
#   GRACE       how long to wait for the first check to register (default: 300)
#   SETTLE      check set must be non-empty and stable this long (default: 45)
#   EXPECT_SHA  abort if the PR head moves off this SHA (default: unset = no guard)

set -uo pipefail

PR="${1:-}"
[ -n "$PR" ] || { echo "usage: wait-for-checks.sh <pr-number|url|branch>" >&2; exit 5; }

INTERVAL="${INTERVAL:-30}"
TIMEOUT="${TIMEOUT:-2700}"
GRACE="${GRACE:-300}"
SETTLE="${SETTLE:-45}"
EXPECT_SHA="${EXPECT_SHA:-}"
REPO_ARG=()
[ -n "${REPO:-}" ] && REPO_ARG=(--repo "$REPO")

started=$(date +%s)
first_seen=0          # when a non-empty check set first appeared
last_count=-1         # to detect the set still growing

log() { echo "[wait-for-checks $(date +%H:%M:%S)] $*" >&2; }

while :; do
  now=$(date +%s)
  elapsed=$(( now - started ))

  if [ -n "$EXPECT_SHA" ]; then
    head=$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json headRefOid -q .headRefOid 2>/dev/null)
    if [ -n "$head" ] && [ "$head" != "$EXPECT_SHA" ]; then
      echo "HEAD MOVED: $EXPECT_SHA -> $head — a new push superseded this run."
      exit 3
    fi
  fi

  raw=$(gh pr checks "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json name,bucket,link 2>/dev/null)
  if ! jq -e . >/dev/null 2>&1 <<<"${raw:-}"; then
    raw='[]'   # gh errors with "no checks reported" until the first one registers
  fi
  count=$(jq 'length' <<<"$raw")

  if [ "$count" -eq 0 ]; then
    if [ "$elapsed" -ge "$GRACE" ]; then
      echo "NO CHECKS: none registered on $PR within ${GRACE}s."
      echo "Either this repo runs no CI on the PR, or the workflow's path filters skipped the push."
      exit 4
    fi
    log "no checks registered yet (${elapsed}s/${GRACE}s grace)"
    sleep "$INTERVAL"; continue
  fi

  # The set appeared. Require it to stop growing before trusting a verdict.
  if [ "$count" -ne "$last_count" ]; then
    first_seen=$now; last_count=$count
    log "check set now $count — waiting ${SETTLE}s for it to settle"
    sleep "$INTERVAL"; continue
  fi
  if [ $(( now - first_seen )) -lt "$SETTLE" ]; then
    sleep "$INTERVAL"; continue
  fi

  pending=$(jq '[.[] | select(.bucket=="pending")] | length' <<<"$raw")
  if [ "$pending" -gt 0 ]; then
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
      echo "TIMED OUT after ${elapsed}s with $pending check(s) still pending:"
      jq -r '.[] | select(.bucket=="pending") | "  pending  \(.name)"' <<<"$raw"
      exit 2
    fi
    log "$pending pending of $count (${elapsed}s elapsed)"
    sleep "$INTERVAL"; continue
  fi

  # Terminal. Report every bucket — a summary that only names passes would read
  # identical to a run where everything failed.
  bad=$(jq '[.[] | select(.bucket=="fail" or .bucket=="cancel")] | length' <<<"$raw")
  echo "ALL CHECKS TERMINAL on $PR after ${elapsed}s — $count total, $bad failing"
  jq -r '.[] | select(.bucket=="fail" or .bucket=="cancel") | "  FAIL     \(.name)  \(.link)"' <<<"$raw"
  jq -r '.[] | select(.bucket=="skipping")                  | "  skipped  \(.name)"'         <<<"$raw"
  jq -r '.[] | select(.bucket=="pass")                      | "  pass     \(.name)"'         <<<"$raw"
  [ "$bad" -eq 0 ] && exit 0 || exit 1
done
