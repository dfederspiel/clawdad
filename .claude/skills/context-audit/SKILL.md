---
name: context-audit
description: Audit the context layers for a group or agent. Reports which CLAUDE.md files are in play, lists loaded skills with line counts, and flags any skill over the ~150-line compaction threshold where content may be silently truncated. Use when debugging agent drift, before shipping a new skill, or when an agent seems to ignore rules you thought were loaded. Triggers on "context audit", "audit context", "check compaction", "why is the agent ignoring X", or "/context-audit".
---

# Context Audit

Inspect what context layers feed into an agent or group, and surface compaction-risk skills before they cause silent reliability bugs.

## Why

Claude Code auto-compacts skill files past ~5K tokens each (~150 lines), with a 25K-token combined skill budget. **CLAUDE.md files are always loaded in full.** Rules placed in skills but not CLAUDE.md can vanish silently during long conversations — the agent never sees them and the user can't tell it lost them.

This skill doesn't fix anything. It shows you the shape of the context so you can move critical rules into CLAUDE.md (always loaded) and push reference material into `references/` (loaded on-demand).

Full background in issue #50.

## Usage

The user provides:
- **Target** — a group name (e.g. `test-team`) or the literal word `global` for repo-wide skills. If not given, ask.

Optional:
- **Threshold** — override the default 150-line compaction warning (e.g. `threshold=200`).

## Steps

### 1. Resolve the target

Group targets resolve to `groups/{folder}/`. If the user gave a group name without the `web_` prefix, try both.

```bash
GROUP="test-team"
GROUP_DIR=""
for candidate in "groups/${GROUP}" "groups/web_${GROUP}"; do
  if [ -d "$candidate" ]; then GROUP_DIR="$candidate"; break; fi
done
[ -z "$GROUP_DIR" ] && echo "No such group: $GROUP" && exit 1
```

### 2. Inventory CLAUDE.md layers

These always survive compaction. Report which exist and their line counts:

```bash
for f in \
  "groups/global/CLAUDE.md" \
  "groups/global-web/CLAUDE.md" \
  "${GROUP_DIR}/CLAUDE.md" \
  "${GROUP_DIR}/agents"/*/CLAUDE.md; do
  [ -f "$f" ] && printf "%4d  %s\n" "$(wc -l < "$f")" "$f"
done
```

### 3. Inventory container skills

Container skills load into every agent in the group at spawn time. Scan `container/skills/` for each SKILL.md and flag any over the threshold:

```bash
THRESHOLD=${THRESHOLD:-150}
echo "Container skills (loaded into every agent in $GROUP):"
for f in container/skills/*/SKILL.md; do
  lines=$(wc -l < "$f")
  name=$(basename "$(dirname "$f")")
  if [ "$lines" -gt "$THRESHOLD" ]; then
    echo "  ⚠  $name: $lines lines (over threshold — content past line $THRESHOLD may be truncated)"
  else
    echo "  ✓  $name: $lines lines"
  fi
done
```

### 4. Peek at what's past the threshold

For each over-threshold skill, show the first 5 lines of content past the threshold. Critical rules placed there are the most at-risk:

```bash
for f in container/skills/*/SKILL.md; do
  lines=$(wc -l < "$f")
  name=$(basename "$(dirname "$f")")
  if [ "$lines" -gt "$THRESHOLD" ]; then
    echo
    echo "--- $name: content past line $THRESHOLD (compaction risk) ---"
    sed -n "$((THRESHOLD + 1)),$((THRESHOLD + 20))p" "$f"
  fi
done
```

### 5. Report and recommend

Present a concise summary. Example:

```
Group: test-team (groups/web_test-team/)

CLAUDE.md layers (always loaded):
  92   groups/global/CLAUDE.md
  47   groups/global-web/CLAUDE.md
  34   groups/web_test-team/CLAUDE.md
  28   groups/web_test-team/agents/coordinator/CLAUDE.md
  22   groups/web_test-team/agents/analyst/CLAUDE.md

Container skills (compaction threshold: 150 lines):
  ✓  status: 89 lines
  ✓  capabilities: 134 lines
  ⚠  agent-browser: 170 lines (20 lines past threshold)
  ⚠  credential-proxy: 217 lines (67 lines past threshold)
  ⚠  rich-output: 291 lines (141 lines past threshold)

Recommendations:
  - rich-output has substantial content past line 150. Any MUST-follow rules in that
    tail should be moved to groups/global-web/CLAUDE.md or the relevant group CLAUDE.md,
    with reference material pushed into rich-output/references/.
  - Apply the same check to credential-proxy and agent-browser.
```

### 6. Flag specific rule patterns (optional)

If the user asks for a deeper scan, grep for imperative patterns inside the at-risk region and surface them as "critical rules at risk":

```bash
for f in container/skills/*/SKILL.md; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt "$THRESHOLD" ]; then
    name=$(basename "$(dirname "$f")")
    tail -n +$((THRESHOLD + 1)) "$f" \
      | grep -niE "^[#>*-]*\s*(never|always|must|only|do not|never use|required)" \
      | head -5 \
      | awk -v n="$name" -v offset="$THRESHOLD" -F: \
          '{printf "  %s (line ~%d): %s\n", n, $1 + offset, $2}'
  fi
done
```

These are the highest-leverage candidates to lift into a CLAUDE.md layer.

## When to run

- **Before shipping a new skill** — verify it fits under the threshold, or at least that nothing past line 150 is load-bearing
- **When an agent ignores a rule you added** — likely the rule is past the compaction cutoff and never reached the model
- **Periodically** — as skills grow, new compaction risks appear. Monthly is reasonable
- **After a compaction-related bug** — confirm the fix landed in a durable layer (CLAUDE.md, not just a skill)

## What this skill does NOT do

- Rewrite skills to meet the threshold (that's #26 / `/skills` maintenance work)
- Validate skill frontmatter (that's `scripts/validate-skills.mjs`)
- Report host-side Claude Code skills for the dev user's own workflow (scope is container agents)
