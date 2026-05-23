#!/usr/bin/env bash
set -euo pipefail

# agy-delegate.sh — hand ONE self-contained task to the local `agy` (Antigravity)
# CLI in non-interactive print mode (`agy -p`), scoped to a target directory, and
# stream its answer back. Thin wrapper: enforces the --add-dir scope (agy otherwise
# works in its OWN runtime dir, not your repo), bumps the print timeout for
# unattended work, checks login, and exits with agy's own exit code.
#
# Usage:
#   agy-delegate.sh --dir <path> [--read] [--timeout DUR] [-c | --conversation ID] "<brief>"
#   echo "<brief>" | agy-delegate.sh --dir <path>
#
# Flags:
#   --dir <path>        REQUIRED. Directory agy operates in (passed as --add-dir,
#                       resolved to an absolute path). Without it, agy works in
#                       ~/.gemini/antigravity-cli, not your code.
#   --read              Read-only/second-opinion mode: prepend a "review only"
#                       preamble and DO NOT pass --dangerously-skip-permissions.
#                       Soft guarantee only — always `git diff` after (see SKILL.md).
#   --timeout DUR       agy --print-timeout value (Go duration). Default 1800s.
#   -c, --continue      Continue agy's most recent conversation.
#   --conversation ID   Resume a specific agy conversation by id.
#   -h, --help          Show this help.
#
# Brief comes from the positional argument, or from stdin if none is given.
# See ../SKILL.md for the full workflow and gotchas.

die() { echo "agy-delegate: $*" >&2; exit 1; }

usage() { sed -n '3,28p' "$0"; }

dir=""
read_only=0
timeout="1800s"
brief=""
resume=()   # -c / --conversation ID, applied before -p

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          dir="${2:-}"; shift 2 ;;
    --read)         read_only=1; shift ;;
    --timeout)      timeout="${2:-}"; shift 2 ;;
    -c|--continue)  resume+=(--continue); shift ;;
    --conversation) resume+=(--conversation "${2:-}"); shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; brief="$*"; break ;;
    -*)             die "unknown flag: $1 (see --help)" ;;
    *)              [ -z "$brief" ] && brief="$1" || brief="$brief $1"; shift ;;
  esac
done

# Brief from stdin when no positional was given.
if [ -z "$brief" ]; then
  [ -t 0 ] && die "no brief: pass it as an argument or pipe it on stdin"
  brief="$(cat)"
fi
[ -n "$brief" ] || die "empty brief"

# Scope + readiness checks (fail fast before spending a model call).
[ -n "$dir" ] || die "missing --dir <path>: agy needs --add-dir or it runs in its own runtime dir"
[ -d "$dir" ] || die "--dir is not a directory: $dir"
command -v agy >/dev/null 2>&1 || die "agy not on PATH"
[ -f "$HOME/.gemini/oauth_creds.json" ] || die "agy not logged in — run 'agy' interactively to authenticate"

abs_dir="$(cd "$dir" && pwd)"

# Always-non-empty args array (safe under macOS bash 3.2); -p "$brief" stays LAST.
agy_flags=(--add-dir "$abs_dir" --print-timeout "$timeout")
agy_flags+=(${resume[@]+"${resume[@]}"})

if [ "$read_only" -eq 1 ]; then
  brief="REVIEW ONLY. Do not modify, create, or delete any file, and do not run any state-changing command (no writes, installs, commits, or migrations). Investigate and report your findings only.

$brief"
else
  agy_flags+=(--dangerously-skip-permissions)
fi

exec agy "${agy_flags[@]}" -p "$brief"
