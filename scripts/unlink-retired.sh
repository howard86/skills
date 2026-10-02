#!/usr/bin/env bash
set -euo pipefail

# Removes the local symlinks of skills retired on this machine without touching
# the repo. `engineering/` and `productivity/` track the upstream fork, so moving
# a skill there into `deprecated/` is a permanent rebase cost; an unlink is free
# and reversible, but `link-skills.sh` (upstream-owned, only adds and replaces)
# recreates every symlink on each run. Run this right after it:
#
#   scripts/link-skills.sh && scripts/unlink-retired.sh
#
# Only a symlink that resolves into this repo is removed, so a third-party copy
# or a hand-made link under the same name is left alone. Re-run is a no-op.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESTS=("$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.gemini/config/skills")

# Retired 2026-09-01: zero loads in the transcript corpus then, and still zero in
# the 30 days to 2026-10-01 after a linker run had silently restored them.
RETIRED=(
  code-review
  codebase-design
  diagnosing-bugs
  domain-modeling
  prototype
  tdd
  wizard
)

removed=0
for DEST in "${DESTS[@]}"; do
  for name in "${RETIRED[@]}"; do
    target="$DEST/$name"
    [ -L "$target" ] || continue
    case "$(readlink "$target")" in
      "$REPO"/skills/*) rm "$target"; removed=$((removed + 1)); echo "unlinked $target" ;;
      *) echo "kept $target (not a link into this repo)" ;;
    esac
  done
done
echo "removed $removed symlink(s); retired list: ${RETIRED[*]}"
