---
name: clawdoodles
description: Manage Clawdoodle packs and templates. Create new templates, manage packs, audit quality, and switch the active pack. Triggers on "clawdoodle", "template", "pack", "add template", "create pack", "switch pack".
---

# Clawdoodles — Pack & Template Management

Clawdoodles are agent templates organized into **packs**. Each pack is a themed set of 9+ templates across difficulty tiers (beginner, advanced, recipe). One pack is active at a time — its templates show in the web UI's + menu.

## Directory Structure

```
clawdoodles/
├── blocks/              # Reusable building blocks (platform primitives)
├── fragments/           # Structural scaffolding for templates
├── packs/
│   ├── starter/         # Default pack (active)
│   │   ├── pack.json    # Pack metadata + achievement definitions
│   │   ├── morning-vibes/
│   │   ├── deal-hunter/
│   │   └── ...
│   └── team-ops/        # Engineering team workflows
│       ├── pack.json
│       └── ...
├── generator-prompt.md  # System prompt for AI template generation
└── manifest.json        # Active pack pointer + block registry
```

## Commands

Parse the user's request to determine which operation:

### `/clawdoodles list` — Show packs and templates

1. Read `clawdoodles/manifest.json` for active pack
2. List all packs in `clawdoodles/packs/` with their pack.json metadata
3. For the active pack, show all templates grouped by tier
4. Show achievement definitions from the active pack's pack.json

### `/clawdoodles switch [pack]` — Change active pack

1. Verify the pack exists in `clawdoodles/packs/`
2. Update `manifest.json` → `activePack` field
3. Confirm: the web UI will show the new pack's templates on next load
4. Remind: `npm run build` is NOT needed — manifest is read at runtime

### `/clawdoodles create pack [name]` — Create a new pack

1. Ask: "What's this pack for?" (theme, audience, purpose)
2. Ask: "How many templates?" (recommend 9 — 3 per tier)
3. Create `clawdoodles/packs/{name}/pack.json` with metadata
4. Design achievement definitions for the pack:
   - Group into categories (e.g., "first_steps", "core_skills", "mastery")
   - Each achievement needs: id, name, description, xp
   - Achievements should tell a progression story
5. Scaffold empty template directories

### `/clawdoodles add [template]` — Add a template to the active pack

1. Ask: "What does this template teach?" (which platform concepts)
2. Ask: "What tier?" (beginner / advanced / recipe)
3. Ask: "Describe the scenario" (what the agent does)
4. Check which blocks are relevant (read `clawdoodles/blocks/`)
5. Create the template:
   - `meta.json` — name, description, tier
   - `agent-config.example.json` — default config fields
   - `CLAUDE.md` — full agent instructions using blocks as reference
6. **CLAUDE.md requirements:**
   - First-run config check + guided onboarding
   - Achievement hooks from the pack's pack.json (reference by category)
   - Interactive commands table
   - Event logging via event-log.sh
   - Progressive discovery suggestions
   - Files section
   - At least 150 lines
7. Update pack.json if new achievements are needed

### `/clawdoodles fix [template]` — Improve a template

1. Read the template's CLAUDE.md
2. Check against quality standards (below)
3. Fix issues: stale tool names, missing achievements, weak onboarding
4. Verify all referenced tools exist in `clawdoodles/blocks/`

### `/clawdoodles audit` — Quality check all templates in active pack

For each template in the active pack:

1. **Achievement coverage** — every achievement in pack.json is referenced by at least one template
2. **Tool references** — all tools/scripts in CLAUDE.md exist in blocks
3. **File paths** — `/workspace/group/`, `/workspace/scripts/` match container reality
4. **Onboarding flow** — has config check, guided setup, achievement unlocks
5. **Rich output** — uses :::blocks::: for structured content
6. **Event logging** — has event-log.sh examples
7. **Interactive commands** — has a commands table
8. **Progressive discovery** — suggests next steps
9. **Length** — CLAUDE.md is 150+ lines

Report as a table with pass/fail per check.

### `/clawdoodles generate [description]` — AI-generate a template

1. Read the blocks library and generator-prompt.md
2. Use the description to generate a complete template (meta.json, CLAUDE.md, agent-config)
3. Write to the active pack
4. Review and adjust before committing

## Pack Design Guidelines

### Achievement Design

Each pack defines achievements in pack.json grouped into categories:

```json
{
  "achievements": {
    "first_steps": [
      { "id": "first_contact", "name": "First Contact", "description": "...", "xp": 10 }
    ],
    "core_skills": [...],
    "mastery": [...]
  }
}
```

- **Categories tell a story:** first_steps → core_skills → mastery
- **XP increases with difficulty:** 10-15 for basics, 20-25 for skills, 30+ for mastery
- **Every template should unlock 4-7 achievements**
- **Achievements should feel earned,** not given away — unlock at moments of genuine progress

### Template Quality Standards

- CLAUDE.md 150+ lines with real depth
- First-run config check with guided one-at-a-time onboarding
- Achievement hooks with explicit pack category references
- Rich output blocks for all structured content
- Event logging for key domain events
- Interactive commands table
- Progressive discovery (suggest features + other templates)
- References only tools that exist in the blocks library

### Pack Sizing

- **Standard:** 9 templates (3 per tier)
- **Mini:** 3-6 templates (focused theme)
- **Full:** 12+ templates (comprehensive coverage)
- Every pack needs a pack.json with achievements
