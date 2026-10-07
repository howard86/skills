#!/usr/bin/env bash
set -euo pipefail

# Symlinks scripts/git-hooks/* into the repo's hooks directory, so the links in
# every harness skill directory follow pulls, rebases, and branch switches
# (sync-skill-links.sh) and commits are checked against the bucket contract
# (check-skills.sh). Hooks live in the shared git dir, so linked worktrees run
# them too: the sync hooks skip themselves there, the pre-commit check does not.
# Re-run after adding a hook file. A branch without scripts/git-hooks leaves
# the symlinks dangling, which git treats as no hook.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS="$(git -C "$REPO" rev-parse --path-format=absolute --git-path hooks)"
mkdir -p "$HOOKS"
for src in "$REPO"/scripts/git-hooks/*; do
  name="$(basename "$src")"
  target="$HOOKS/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skipped $name: $target is an existing hook, not a symlink" >&2
    continue
  fi
  ln -sfn "$src" "$target"
  echo "installed $name -> $src"
done
