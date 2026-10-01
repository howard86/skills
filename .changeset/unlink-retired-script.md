---
"mattpocock-skills": patch
---

Add `scripts/unlink-retired.sh`: removes the local symlinks of the seven `engineering/` skills retired on this machine, so a `link-skills.sh` run no longer restores them silently. Only links that resolve into this repo are removed. `CLAUDE.md` says to run it after the linker.
