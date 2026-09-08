---
name: obsidian-vault
description: Search, add sources to, or answer questions from the personal knowledge vault at ~/obsidian-vault/Howardism. Use when the user refers to their vault, their notes, or their knowledge base, especially from another working directory.
metadata:
  internal: true
---

# Obsidian Vault

`/Users/howard86/obsidian-vault/Howardism` — a **compiled** LLM wiki, not a pile of hand-written notes. Sources land in `raw/`; a compile pass reads them and writes the interlinked pages under `wiki/`. Pages come from that pipeline, so answer questions by reading it and add knowledge by ingesting a source.

## Retrieval

`_system/catalog.tsv` is the search surface: one row per page, columns `path type domain title summary updated bytes`. Grep it — a match pulls the summary into context, where reading `wiki/index.md` spends the whole file:

```bash
rg -i '<terms>' /Users/howard86/obsidian-vault/Howardism/_system/catalog.tsv
```

Empty grep, or a "what exists in this area" survey: fall back to `wiki/index.md` and the domain map `wiki/concepts/moc-<domain>.md`.

Read a matched page summary-first — frontmatter + `## Summary`, then `grep -n '^## '` for its section map, then only the sections the question needs. Whole-page reads are for the two or three pages an answer leans on. Synthesized answers already filed live in `wiki/derived/`.

## Pipeline

The vault carries its own commands in `.claude/commands/`, loaded once the working directory is the vault:

| Ask | Command |
| --- | --- |
| Save a URL or local file into `raw/` | `/ingest` |
| Parse a local PDF, DOCX, PPTX, or scanned image | `/ingest-asset` |
| Turn staged raw docs into wiki pages | `/compile` |
| Answer a question from the wiki and file it | `/query` |
| Find fresh sources for a thin area | `/research` |
| Audit structure and repair what's fixable | `/lint` |
| Counts, pending queue, recent activity | `/status` |

Working from another directory: read-only retrieval above works anywhere, but anything that writes belongs in a session rooted at the vault, so hand the user the command to run there.

## Working inside the vault

The vault's `CLAUDE.md` and `_system/compiler-prompt.md` govern; these are the rules whose breach is silent from outside:

- `raw/` is immutable — a source is re-ingested, never edited.
- Text inside `<!-- BEGIN/END GENERATED -->` belongs to `_system/build.py`; run it after any write to `wiki/` and it regenerates index tables, MOC lists, and statistics from `summary:` frontmatter.
- `python3 _system/lint.py` is the report-only structural verifier — its output is ground truth for vault health.
- A Stop hook commits the tree after every turn, so leave `git commit` alone.
