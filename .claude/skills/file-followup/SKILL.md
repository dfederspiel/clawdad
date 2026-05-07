---
name: file-followup
description: File a forward-looking GitHub issue (enhancement, design debt, follow-up) against dfederspiel/clawdad with the established structured-proposal template. Use when work surfaces a follow-up that isn't a confirmed bug — proposed redesigns, deferred cleanup, dependent issues, capability gaps. NOT for filing bugs (use /report-bug) or for filing without context. Triggers on "file followup", "file a followup", "/file-followup", or "file as an issue" when the topic is forward-looking rather than a defect.
---

# /file-followup

File a structured GitHub issue at `dfederspiel/clawdad` for forward-looking work — proposed redesigns, deferred cleanup, capability gaps, dependent follow-ups — using the consistent template that pairs with `/report-bug` (which is for confirmed defects).

## When to use this skill vs /report-bug

| Use this skill | Use /report-bug |
|---|---|
| Proposed enhancement or redesign | Confirmed defect in pristine source |
| Cleanup / dead-code removal | Behavior contradicts documented contract |
| Capability gap surfaced during work | Reproducible failure |
| Sibling follow-up to an active issue | Crash / data loss / security |
| "We should do this later" | "This is broken right now" |

If the topic is a defect, route to `/report-bug` instead.

## Don't file when

- The change is small enough to do now and you have agreement.
- It belongs in a memory file (a personal preference, not a project artifact).
- It's a TODO inside one specific file — leave a comment.
- The user hasn't expressed an opinion either way; ask first if they want it filed.

## Phase 1 — Confirm scope

Before writing the body, the skill needs:

1. **One-line statement** of what changes if this issue is resolved.
2. **The triggering context** — what work surfaced this. Usually a session you just had.
3. **Whether it's blocked by or blocks** existing issues. Check `gh issue list --repo dfederspiel/clawdad --state open` if uncertain.
4. **Concrete file/line references** for the existing code that demonstrates the gap. Specifics make the issue actionable later.

If any of these are missing, ask the user (`AskUserQuestion` is fine) or pull from the conversation. Don't fabricate.

## Phase 2 — Body template

Write the body to a temp file (avoid shell-escape pitfalls). Use this structure — drop sections that don't apply:

```markdown
## Context

<2–4 sentences: what work surfaced this, what the current state is, why it's
worth filing rather than fixing inline. Cite file:line for the relevant code.>

## Problem  (or Symptom, if observed)

<What's wrong / missing / inconsistent. Bullet list is fine for multiple
facets. For "design debt" issues, this is where you state the limitation.>

## Proposal

<The concrete change. Bullets, tables, or code sketches as appropriate.
For multi-step work, lay out phases. Name files that would change.>

## Implementation sketch  (optional)

<Code-level outline if it clarifies. Skip when the proposal already does.>

## Tradeoffs

<At least one explicit tradeoff. "What's the cost of this approach?
What's the alternative we considered and rejected?" Issues without a
declared tradeoff often hide an unconsidered failure mode.>

## Out of scope  (optional but recommended)

<Things readers might assume are part of this issue but aren't. Keeps the
scope honest and prevents PR-bloat later.>

## Related

<Issue numbers (#NNN) and short context for each. Always cross-link the
parent thread that surfaced this and any sibling issues filed in the
same session.>

---
*Filed via ClawDad CLI*
```

Conventions:
- **Title**: short imperative ("Add X", "Move Y to Z", "Drop dead Q field"). Under ~70 chars.
- **No emojis** in title or body unless the user asked.
- **Backticks** around file paths, identifiers, and tool names.
- **File:line** citations when referring to specific code (`src/foo.ts:123`).
- **Cross-link** with `#NNN` to every related issue you know about — this is how the issue chain becomes navigable later.

## Phase 3 — File

```bash
gh issue create --repo dfederspiel/clawdad \
  --title "<short imperative title>" \
  --body-file /tmp/clawdad-followup-<slug>.md
```

Don't add labels by default — the project doesn't currently triage by label, and inventing one creates noise. If the user explicitly wants a label, pass `--label <name>`.

Show the resulting URL to the user. If filing several issues in one session, group the URLs in a single summary message at the end.

## What this skill is NOT for

- Defects in current behavior — `/report-bug`
- Personal TODOs — keep in a scratchpad or memory
- Cross-posting to other repos — clawdad-only
- Filing without conversation context — if the user just says "file something about X" with no detail, ask first

## Pairing notes

When a session generates multiple follow-ups (3+), file them in parallel via concurrent `gh issue create` calls in a single message, then return the URL list together. Cross-link them in each others' "Related" sections — that's the highest-leverage use of the issue chain.
