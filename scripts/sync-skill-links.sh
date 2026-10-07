#!/usr/bin/env bash
set -uo pipefail

# Brings every harness skill directory in line with the checked-out tree, the
# whole sequence CLAUDE.md asks for by hand after a pull, rebase, or rename:
#   link-skills.sh, unlink-retired.sh, link-agents.sh, a prune, then check-skills.sh.
# The prune covers what the linker never does: it removes a symlink that points
# into this repo's skills/ but dangles (a renamed or removed skill) or resolves
# into a bucket the linker skips (a demoted skill). Anything that is not a
# symlink into this repo is left alone: the linker already replaced every copy
# under a name the repo owns, so a real directory left over is a third-party
# install.
#
# Run by the post-merge, post-rewrite, and post-checkout hooks (install with
# scripts/install-git-hooks.sh); safe to run by hand. A no-op inside a linked
# worktree or mid-rebase, since linking from there points every symlink at a
# tree that is about to move or vanish.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 0
DESTS=("$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.gemini/config/skills")

git_dir="$(cd "$(git rev-parse --git-dir)" && pwd -P)"
common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
if [ "$git_dir" != "$common_dir" ]; then
  echo "sync-skill-links: skipped in a linked worktree; run from the main checkout" >&2
  exit 0
fi
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] || [ -f "$git_dir/MERGE_HEAD" ]; then
  exit 0
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
{ scripts/link-skills.sh && scripts/unlink-retired.sh && scripts/link-agents.sh; } >"$log" 2>&1 \
  || { cat "$log" >&2; echo "sync-skill-links: linking failed" >&2; exit 1; }

pruned=0
for DEST in "${DESTS[@]}"; do
  [ -d "$DEST" ] || continue
  for entry in "$DEST"/*; do
    [ -L "$entry" ] || continue
    target="$(readlink "$entry")"
    case "$target" in
      "$REPO"/skills/*) ;;
      *) continue ;;
    esac
    case "$target" in
      "$REPO"/skills/deprecated/*|"$REPO"/skills/misc/*|"$REPO"/skills/in-progress/*) ;;
      *) [ -e "$entry" ] && continue ;;
    esac
    rm "$entry" && pruned=$((pruned + 1)) && echo "sync-skill-links: pruned $entry -> $target"
  done
done

linked="$(grep -c '^linked ' "$log")"
echo "sync-skill-links: $linked link(s) refreshed, $pruned pruned"
scripts/check-skills.sh || true
