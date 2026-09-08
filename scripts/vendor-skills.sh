#!/usr/bin/env bash
set -euo pipefail

# Vendors third-party skills that otherwise only exist inside an installed
# Claude Code plugin, so the prose survives uninstalling the plugin.
#
# Output lands in vendor/ at the repo root — deliberately NOT under skills/,
# because scripts/link-skills.sh walks skills/ and would install every vendored
# copy alongside the plugin's own namespaced one.
#
# Caveat: this vendors the skill *documents*, not the plugins' runtimes. A
# vendored skill that drives a CLI still describes a tool that isn't there once
# its plugin is gone. Ponytail and skill-creator are prose plus scripts and
# stand alone.
#
# Re-run to update. Each skill gets a SOURCE.md recording the exact commit it
# came from; `git diff vendor/` after a run is the upstream changelog.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO/vendor"

# dest-name | github repo | path within that repo
MANIFEST="
ponytail|DietrichGebert/ponytail|skills/ponytail
skill-creator|anthropics/claude-plugins-official|plugins/skill-creator/skills/skill-creator
"

entries="$(echo "$MANIFEST" | grep -v '^$')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One sparse clone per source repo, however many skills we take from it.
for repo in $(echo "$entries" | cut -d'|' -f2 | sort -u); do
  clone="$work/$(echo "$repo" | tr '/' '_')"
  echo "==> cloning $repo"
  git clone --quiet --depth 1 --filter=blob:none --sparse \
    "https://github.com/$repo.git" "$clone"

  paths=$(echo "$entries" | awk -F'|' -v r="$repo" '$2 == r { print $3 }')
  # shellcheck disable=SC2086 # each path is a separate sparse-checkout arg
  git -C "$clone" sparse-checkout set $paths
done

mkdir -p "$DEST"
while IFS='|' read -r name repo path; do
  [ -n "$name" ] || continue
  clone="$work/$(echo "$repo" | tr '/' '_')"
  src="$clone/$path"

  if [ ! -d "$src" ]; then
    echo "error: $repo no longer has $path — update the manifest" >&2
    exit 1
  fi

  rm -rf "${DEST:?}/$name"
  cp -R "$src" "$DEST/$name"

  sha="$(git -C "$clone" rev-parse HEAD)"
  cat > "$DEST/$name/SOURCE.md" <<EOF
# Vendored copy — do not edit

| | |
| --- | --- |
| Source | https://github.com/$repo/tree/$sha/$path |
| Commit | \`$sha\` |
| Vendored | $(date -u +%Y-%m-%d) |

Edits here are overwritten by \`scripts/vendor-skills.sh\`. Send changes upstream.
EOF

  echo "vendored $name <- $repo/$path @ ${sha:0:7}"
done <<< "$entries"
