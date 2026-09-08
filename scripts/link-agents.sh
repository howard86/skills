#!/usr/bin/env bash
set -euo pipefail

# Links this repo's agents/ into ~/.claude/agents, the way link-skills.sh does
# for skills. Kept separate because link-skills.sh is upstream-owned and covers
# skills only, so agent symlinks had nothing maintaining them — they broke
# silently on 2026-08-14 when the repo moved from ~/claude/skills to
# ~/howardism/skills, leaving both sonnet-* agents unresolvable by any name.
#
# Re-run after adding, removing, or renaming an agent, or after moving the repo.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/agents"

mkdir -p "$DEST"

for src in "$REPO"/agents/*.md; do
  # An empty agents directory has no definitions to link.
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  target="$DEST/$name"

  # A real file/dir here shadows the repo copy; replace it. A dangling symlink
  # fails -e, so it falls through to ln -sfn below and gets repointed.
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    rm -rf "$target"
  fi

  ln -sfn "$src" "$target"
  echo "linked $name -> $src"
done
