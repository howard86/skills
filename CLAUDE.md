Skills are organized into bucket folders under `skills/`:

- `engineering/`: daily code work
- `productivity/`: daily non-code workflow tools
- `howardism/`: my own skills, with no counterpart in the upstream fork
- `misc/`: kept around but rarely used, not promoted
- `personal/`: tied to my own setup, not promoted
- `in-progress/`: beta: public on purpose, feedback wanted, not shipped in the plugin
- `deprecated/`: no longer used

New skills go in `howardism/` unless told otherwise. `engineering/` and `productivity/` track the upstream fork, so additions there turn into rebase conflicts.

Every skill in `engineering/`, `productivity/`, or `howardism/` (the **promoted** buckets) must have a reference in the top-level `README.md` and an entry in `.claude-plugin/plugin.json`'s `skills` array (the Claude Code plugin ships exactly the promoted set). Skills in `misc/`, `personal/`, `in-progress/`, and `deprecated/` must not appear in either.

Install commands are copied verbatim from [.agents/install-block.md](./.agents/install-block.md). `.claude-plugin/marketplace.json` makes the repo its own single-plugin marketplace (a fallback the install block explains, not the documented route). Run `claude plugin validate . --strict` after touching either manifest. Why a Claude plugin but not (yet) a Codex one lives in [.agents/adr/0002-ship-as-a-claude-code-plugin.md](./.agents/adr/0002-ship-as-a-claude-code-plugin.md).

Each skill entry in the top-level `README.md` must link the skill name to its `SKILL.md`.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`. The promoted buckets' `README.md`s and the top-level `README.md` group entries into **User-invoked** and **Model-invoked**; non-promoted bucket `README.md`s (`misc/`, `in-progress/`) use a flat list.

Skills in `engineering/` and `productivity/` also have a human-facing docs page at `docs/<bucket>/<skill-name>.md` (the docs tree mirrors those two bucket folders under `skills/`). The published URL is `https://aihero.dev/skills-<skill-name>` regardless of bucket: the docs path is repo organisation only. When you add, rename, or change the behaviour of a skill in `engineering/` or `productivity/`, create or re-sync its docs page following [.agents/writing-docs.md](./.agents/writing-docs.md). A finished page carries four sections: **What it does**, **When to reach for it**, **Common questions**, and **It's working if**. `writing-docs.md` holds the template, the section order, and where to hunt for the questions. Skills in the non-promoted buckets (`misc/`, `in-progress/`, `deprecated/`) get **no** docs page.

Every `SKILL.md` is either user-invoked (`disable-model-invocation: true` plus `policy.allow_implicit_invocation: false` in `agents/openai.yaml`, reachable only by the human) or model-invoked (model- or user-reachable). See [.agents/invocation.md](./.agents/invocation.md).

[`ask-matt`](./skills/engineering/ask-matt/SKILL.md) is the router that maps every user-reachable skill and how they relate. The same trigger that re-syncs a docs page applies to it: whenever you add, rename, remove, or change how a user-reachable skill fits the flows, re-read `ask-matt`'s `SKILL.md` and update it so the map stays accurate: a new skill it never mentions, or a stale one it still routes to, is a router that lies.

To (re)link every skill outside `deprecated/` and `misc/` into the local harness skill directories (`~/.claude/skills`, `~/.agents/skills`), run `scripts/link-skills.sh`. Each entry is a symlink into this repo, so a `git pull` keeps installed skills current; re-run the script after adding, removing, or renaming a skill. Run it from the main checkout only: run inside a git worktree (e.g. by a subagent) it silently points every symlink at the worktree, and they all dangle when the worktree is removed; re-run from the main checkout after merging.

A deployed entry that is a *real directory* rather than a symlink is a frozen copy: the skill still loads, so the drift is silent, and anything added beside `SKILL.md` later (a `scripts/` runner) never appears at `${CLAUDE_SKILL_DIR}`. Audit with `for d in ~/.agents/skills/*/; do [ -L "${d%/}" ] || echo "${d%/}"; done`.

Copies arrive from third-party installers (`bunx github.com/vercel-labs/skills` copies rather than links). Re-running the linker replaces any copy whose name this repo owns and leaves the rest alone, so adopt a third-party copy worth keeping into a bucket and it becomes a symlink like everything else. A copy under a name the repo has since **renamed** is the one case the linker can never clean up, because it only walks current names: it lingers as a stale duplicate competing for the same triggers, which is how `diagnose` outlived its rename to `diagnosing-bugs` by eleven days.

`scripts/link-agents.sh` does the same for `agents/` into `~/.claude/agents`. It is separate because `link-skills.sh` is upstream-owned and skills-only; re-run it after adding, removing, or renaming an agent, **and after moving the repo**: nothing else maintains those links, and a stale one leaves the agent unresolvable by any name.

`vendor/` holds read-only copies of third-party skills that ship inside installed plugins, regenerated by `scripts/vendor-skills.sh` (manifest at the top of that script). It is **not** a bucket: it sits outside `skills/` so `link-skills.sh` doesn't install every copy a second time, and nothing in it goes in `README.md` or `.claude-plugin/plugin.json`. See [vendor/README.md](./vendor/README.md).

No em-dashes anywhere in this repo's prose (`SKILL.md` files, docs, `README.md`, `CHANGELOG.md`, ADRs, changesets, code comments). Where a sentence reaches for one, rewrite it instead with a comma, colon, period, parentheses, or a conjunction, whichever the sentence actually wants; never do a blind character substitution.

Before delegating work, use `/subagent-routing` to identify the running harness and
read its subagent reference. Model choice and imported instruction paths do not
identify the harness. The canonical entrypoint is
[Subagent Routing](./skills/howardism/subagent-routing/SKILL.md).
