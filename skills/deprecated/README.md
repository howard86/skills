# Deprecated

Skills I no longer use. Nothing here is linked into a harness skill directory, listed in the top-level README, or shipped in the plugin. A skill lands here when two retros in a row find it never invoked; the changeset that moves it names what replaced it, and a later change may delete it outright.

Retired 2026-09-24 (all user-invoked, zero invocations across the whole transcript corpus, each six weeks or older when the first retro flagged them on 2026-09-09):

- **[claude-handoff](./claude-handoff/SKILL.md)**: Hand the current conversation off to a fresh background agent seeded with a handoff summary via `claude --bg`. Replaced by `subagent-routing` plus the harness's own resumable named agents.
- **[loop-me](./loop-me/SKILL.md)**: Grill yourself into implementable workflow specs over multiple sessions, using the current directory as a stateful workspace. `grilling` covers the interview; nothing replaced the multi-session state.
- **[setup-ts-deep-modules](./setup-ts-deep-modules/SKILL.md)**: Wire dependency-cruiser into a TypeScript repo so each package is a deep module reachable only through its entry-point files. No replacement; the design idea lives on in `codebase-design`.
- **[writing-beats](./writing-beats/SKILL.md)**: Shape an article as a journey of beats, choose-your-own-adventure style. No replacement.
- **[writing-fragments](./writing-fragments/SKILL.md)**: Grilling session that mines you for fragments and appends them to a single document as raw material for a future article. No replacement.
- **[writing-shape](./writing-shape/SKILL.md)**: Take a markdown file of raw material and shape it into an article paragraph by paragraph. No replacement.
