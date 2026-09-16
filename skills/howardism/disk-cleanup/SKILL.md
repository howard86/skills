---
name: disk-cleanup
description: Reclaim disk on this Mac by running the existing housekeeping scripts in the order that works, with the guards they lack. Use when the disk is full or the user asks to clean up unused or large files, review stale worktrees, or free space from build caches.
---

# Disk cleanup

Two scripts already exist; a cleanup ask starts by running them, and `df` is the only trusted measure of what was freed. Done when the after-`df` figure sits next to the before figure and every deletion is listed.

## Steps

1. **Baseline.** `df -h /System/Volumes/Data` before anything. Every size the scripts print is an upper bound: bun installs `node_modules` by APFS clonefile, so `du` counts blocks shared with `~/.bun/install/cache` and sibling worktrees. Compiler output (`target/`, `.next/`) and the global caches are real bytes.
2. **`/private/tmp` first.** `du -sk /private/tmp/* | sort -rn | head -20`. Algorithmic-Trading agent sessions leave whole vault copies here (`compile-*`, `g400-*`, `g200-*`, `factor-*`, `cboe-*`, `*-snapshot`, 17–19 GiB each; 546 GiB found on 2026-09-04) and no periodic cleaner exists, so the housekeeping scripts never see them. For each: `lsof +D <dir> | head` is empty and no Algorithmic Trading session is mid-run → `rm -rf <dir>`, one directory per command. The auto-mode classifier denies batched deletes and anything under `~/.grok`; hand `~/.grok` to the user.
3. **Git housekeeping.** `~/git-housekeep.fish --all` (dry-run) → review → `--all --apply`. It skips detached-HEAD worktrees by design, which is every Claude and Cursor agent worktree: list them with `git worktree list` per repo and remove each with `git worktree remove --force <path>` (allowed where `rm -rf` is denied, and it keeps the repo's metadata consistent). A removed worktree takes its `target/` with it.
4. **Build artifacts.** `~/build-housekeep.fish` (dry-run; `--list` prints the kinds). `target` is reclaimed at any age, everything else honours `--days 14`. Apply with explicit kinds, never bare, whenever `~/claude` is in scope: `--apply --kind target --kind node_modules --kind .next --kind .turbo`. `out` is a default kind and `~/claude/ticks-extractor/out` is 39 GiB of git-ignored parquet market data that only the age gate protects.
5. **Measure.** `df -h /System/Volumes/Data` again; report the delta, never the scripts' sums (2026-08-24: scripts claimed 77 GiB, `df` moved 41).

## Remote hosts

testbed-apne-az2: `~/claude/testbed-disk-cleanup/00-diagnose.sh` … `03-system-cleanup.sh`, layout in its README (toolchains and caches under `/data/tools` and `/data/cache`, compatibility symlinks in `$HOME`). On any build host with a small root and a data disk, the durable fix is `RUSTUP_HOME`, `CARGO_HOME`, `SCCACHE_DIR` on the data disk, applied 2026-08-13, rather than repeated purges.
