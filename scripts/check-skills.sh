#!/usr/bin/env bash
set -euo pipefail

# Checks the bucket contract from CLAUDE.md that nothing else enforces:
#   - skill names are unique across the buckets link-skills.sh installs, since
#     every destination is flat and a shared name lets `find` ordering pick one
#     (how upstream's graduated `retro` would have shadowed ours);
#   - `.claude-plugin/plugin.json` lists exactly the promoted set;
#   - the top-level README.md links every promoted skill's SKILL.md and no
#     non-promoted one.
# Prints one line per violation and exits 1 if there are any. Reads the repo
# only, so it is safe in a worktree. Run by the pre-commit hook and by
# sync-skill-links.sh.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
bad=0
fail() { echo "check-skills: $*" >&2; bad=1; }

# Mirrors link-skills.sh's skip list.
linked="$(find skills -name SKILL.md -not -path '*/node_modules/*' -not -path '*/deprecated/*' -not -path '*/misc/*' -not -path '*/in-progress/*' | xargs -n1 dirname | sort)"
while read -r dup; do
  fail "skill name '$dup' is linked from more than one bucket: $(echo "$linked" | grep "/$dup\$" | tr '\n' ' ')"
done < <(echo "$linked" | xargs -n1 basename | sort | uniq -d)

promoted="$(find skills/engineering skills/productivity skills/howardism -name SKILL.md -not -path '*/node_modules/*' | xargs -n1 dirname | sort)"
manifest="$(jq -r '.skills[] | sub("^\\./"; "")' .claude-plugin/plugin.json | sort)"
while read -r s; do [ -n "$s" ] && fail "promoted skill missing from plugin.json: $s"; done < <(comm -23 <(echo "$promoted") <(echo "$manifest"))
while read -r s; do [ -n "$s" ] && fail "plugin.json lists a non-promoted or missing skill: $s"; done < <(comm -13 <(echo "$promoted") <(echo "$manifest"))

while read -r s; do
  grep -qF "](./$s/SKILL.md)" README.md || fail "README.md does not link $s/SKILL.md"
done <<< "$promoted"
while read -r line; do
  [ -n "$line" ] && fail "README.md links a non-promoted skill: $line"
done < <(grep -oE '\]\(\./skills/(misc|personal|in-progress|deprecated)/[^)]*/SKILL\.md\)' README.md || true)

exit $bad
