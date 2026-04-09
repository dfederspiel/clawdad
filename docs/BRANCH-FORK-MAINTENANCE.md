# Branch & Fork Maintenance Guidelines

## Note On ClawDad

This document describes the historical NanoClaw upstream/fork maintenance model.

ClawDad no longer follows that workflow as an active practice. The project has diverged enough from `qwibitai/nanoclaw` that routine upstream merges are no longer expected. For ClawDad, upstream should be treated as:

- an architectural reference
- a source of occasional targeted cherry-picks
- an ancestor to acknowledge clearly

Not as a branch that this repo continuously rebases or merges.

The rest of this document remains useful as background on the original NanoClaw fork/skill model, but it should not be read as current ClawDad maintenance policy.

## Structure

**`qwibitai/nanoclaw`** (upstream) — core engine with skill definitions (`.claude/skills/`). No channel code on `main`.

**Channel forks** (`nanoclaw-whatsapp`, `nanoclaw-telegram`, `nanoclaw-slack`, etc.) — each fork = upstream + one channel's code applied. Users clone upstream, then merge a fork into their clone to add a channel.

**`skill/*` and `feat/*` branches on upstream** — add features unrelated to channels (e.g. `skill/compact`, `skill/apple-container`). Users merge these into their clone to add capabilities. Channel-specific skill branches that duplicate the forks (e.g. `skill/whatsapp`, `skill/telegram`) are legacy.

## How users add capabilities

```
user clones upstream main
  ├── merges nanoclaw-whatsapp fork  → adds WhatsApp
  ├── merges skill/compact branch    → adds /compact command
  └── merges skill/apple-container   → switches to Apple Container
```

## Merge directions

```
upstream main ──→ channel forks     (forward merge to keep forks caught up)
upstream main ──→ skill branches    (forward merge to keep branches caught up)
```

Forks and skill branches carry applied code changes. Users merge them into their own clones/forks to add capabilities. They are never merged back into upstream `main`.

## Forward merge procedure

```bash
# In your local nanoclaw checkout
git checkout main && git pull

# For a fork:
git fetch nanoclaw-whatsapp
git checkout -B whatsapp-merge nanoclaw-whatsapp/main
git merge main
# Resolve conflicts (see below)
# Remove upstream-only workflows (re-added by every merge since main has them):
git rm .github/workflows/bump-version.yml .github/workflows/update-tokens.yml 2>/dev/null
git push nanoclaw-whatsapp HEAD:main
git checkout main && git branch -D whatsapp-merge

# For a skill branch:
git checkout -B skill/compact origin/skill/compact
git merge main
# Resolve conflicts (see below)
git push origin skill/compact
git checkout main && git branch -D skill/compact
```

## Conflict resolution

The same files conflict every time:

| File | Resolution |
|------|------------|
| `package.json` | Take main's version + keep fork/branch-specific deps |
| `package-lock.json` | `git checkout main -- package-lock.json && npm install` |
| `.env.example` | Combine: main's entries + fork/branch-specific entries |
| `repo-tokens/badge.svg` | Take main's version (auto-generated) |

Source code changes (e.g. `src/types.ts`, `src/index.ts`) usually auto-merge cleanly, but can conflict if both sides modify the same lines. **Always build and test after every forward merge** — auto-merged code can be silently wrong (e.g. referencing a renamed function or using a removed parameter) even when git reports no conflicts.

## When to merge forward

After any main change that touches shared files (`package.json`, `src/index.ts`, `CLAUDE.md`, etc.). Small frequent merges = trivial conflicts. Large infrequent merges = painful.

## Fork setup

When creating a new channel fork:

1. Fork `nanoclaw` to `nanoclaw-{channel}`
2. Remove upstream-only workflows: `bump-version.yml`, `update-tokens.yml`
3. Add channel code, deps, env vars
4. Forward-merge main immediately to establish a clean baseline

## Dependencies

Forks and branches add their own deps on top of upstream's. When upstream adds or removes a dependency, verify that forks/branches still build after the next forward merge — transitive dependency changes can break downstream code.
