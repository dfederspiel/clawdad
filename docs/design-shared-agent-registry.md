# Design: Shared Agent Registry

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

As agents and teams become more capable, they also become more expensive to tune.

A good agent may require:
- prompt iteration
- task tuning
- trigger shaping
- provider/model selection
- automation rule refinement
- real-world observation over time

Today, that work is mostly trapped inside one local install.

This creates three missed opportunities:

- **reuse** — users can’t easily carry a tuned agent between projects or machines
- **sharing** — teams can’t publish or distribute proven agent setups
- **community learning** — people repeat the same tuning work instead of building on curated agents

The system already has templates and skills, but those are not quite the same thing as a tuned, reusable agent or team.

## Design Principle

**Agents should be portable assets.**

A user should be able to:
- publish a tuned agent or team
- browse shared agents from a registry
- install one into a local project
- clone it into local ownership
- optionally pull updates later

The key rule:

**Installed agents should be owned locally by default.**

This should feel more like:
- install a template and keep editing it

than:
- mount a live remote dependency that changes underneath you

---

## Goals

- Define a sharable package format for agents and teams
- Support install/import into local groups
- Preserve local ownership after install
- Allow optional upstream update tracking later
- Support community curation and discoverability

## Non-Goals

- Building a fully decentralized package ecosystem in phase 1
- Live-linked remote agents that auto-update silently
- Solving trust and moderation perfectly in the first version

---

## Concepts

### Shared Agent

A portable agent definition that can be installed into a local project.

It may represent:
- a single standalone agent
- a multi-agent team

### Registry

A browsable source of shared agents, which may be:
- local filesystem
- git repository
- hosted community catalog

### Install

Copy a shared agent into the local project, making it editable and owned locally.

### Upstream Reference

Optional metadata that records where an installed agent came from, so updates can be compared later.

---

## Why Shared Agents Are Different From Skills

Skills and shared agents overlap, but they solve different problems.

### Skills

Best thought of as:
- capabilities
- instructions
- reusable building blocks
- code or workflow extensions

They are closer to ingredients.

### Shared agents

Best thought of as:
- tuned, opinionated, ready-to-run units
- packaged specialists or teams
- reusable operational behavior

They are closer to finished recipes.

Examples:
- “PR Reviewer”
- “Weekly Release Notes Writer”
- “Project Tracker”
- “Research Team”

So the relationship is:

- skills expand what agents can do
- shared agents package how an agent or team is configured to do it

---

## Package Shapes

### Single Agent Package

```text
shared-agent/
  manifest.json
  CLAUDE.md
  agent.json
```

### Team Package

```text
shared-agent/
  manifest.json
  CLAUDE.md
  group-config.json
  agents/
    coordinator/
      CLAUDE.md
      agent.json
    researcher/
      CLAUDE.md
      agent.json
```

### Optional extras

Later, packages could also include:
- example scheduled tasks
- automation rules
- assets
- screenshots
- README

---

## Manifest Format

### Example

```json
{
  "id": "pr-reviewer",
  "name": "PR Reviewer",
  "version": "1.0.0",
  "kind": "agent",
  "description": "Reviews pull requests for regressions and missing tests.",
  "author": "ClawDad Community",
  "tags": ["engineering", "code-review"],
  "runtime": {
    "provider": "openai",
    "model": "gpt-5"
  },
  "compatibility": {
    "minClawdadVersion": "1.2.0"
  }
}
```

### Team Example

```json
{
  "id": "research-team",
  "name": "Research Team",
  "version": "1.0.0",
  "kind": "team",
  "description": "Coordinator + researcher + summarizer for deep dives.",
  "author": "ClawDad Community",
  "tags": ["research", "knowledge-work"],
  "runtimeProfiles": [
    { "provider": "anthropic", "model": "claude-sonnet" },
    { "provider": "openai", "model": "gpt-5" }
  ]
}
```

---

## Installation Model

### Recommended behavior

Install should do a **deep local copy**, not a symlink or live mount.

That means:
- files are copied into the local `groups/...` structure
- the user owns the result
- local edits are safe and expected

### Why local copy is the right default

Benefits:
- no spooky remote changes
- local debugging is straightforward
- users can adapt shared agents to their environment
- version skew is manageable

### What should be copied

For a single agent:
- `CLAUDE.md`
- `agent.json`
- manifest metadata stored separately as provenance

For a team:
- group `CLAUDE.md`
- `group-config.json`
- all `agents/*`

### What should not be copied by default

- live session history
- usage history
- runtime logs
- secrets

Shared agents should distribute behavior, not private operational state.

---

## Upstream Tracking

### Phase 1

Install-only, no update tracking required.

### Phase 2

Store provenance metadata locally:

```json
{
  "source": {
    "registry": "community",
    "packageId": "pr-reviewer",
    "version": "1.0.0"
  }
}
```

This allows later flows like:
- “this local agent was installed from X”
- “an upstream update is available”
- “show diff before applying update”

### Important rule

Updates should be **pull-based and reviewed**, not silently applied.

That means:
- check for updates
- preview changes
- apply selectively

not:
- remote source mutates the local agent automatically

---

## Registry Models

### 1. Local registry

A folder on disk containing shared agent packages.

Good for:
- personal reuse
- team-internal libraries
- fast prototyping

### 2. Git-backed registry

A repo containing manifests and package folders.

Good for:
- versioning
- collaboration
- code review

### 3. Hosted/community registry

A browsable catalog with search, metadata, screenshots, install counts, etc.

Good for:
- discovery
- curation
- broader community sharing

Recommendation:
- start with local or git-backed registry
- add hosted/community UX later

---

## UI Opportunities

### Install surface

Users should be able to:
- browse shared agents
- preview manifest and instructions
- choose install target:
  - standalone group
  - add to existing group
  - import as team

### Group settings integration

For an existing group:
- `Add from registry`
- `Clone local agent`
- `Install team template`

### Agent definition area

Long term, this pairs well with a dedicated “Agent Definitions” section:
- local agents
- imported agents
- updates available
- publish/export

---

## Publishing Model

### Export

A local group or agent can be exported into a package structure:

```text
export/
  manifest.json
  CLAUDE.md
  agent.json
```

or team form.

### Publish flow

Possible flow:
1. choose local agent/group
2. generate manifest
3. review and scrub local-specific values
4. publish to registry source

### What needs scrubbing

Publishing should remove or warn on:
- local mount paths
- secrets
- user-specific URLs
- machine-specific assumptions

This is especially important for:
- `containerConfig.additionalMounts`
- provider endpoints
- environment-specific instructions

---

## Runtime Compatibility

This becomes more important as per-agent runtime selection lands.

A shared agent should declare:
- preferred provider
- preferred model
- fallback/runtime compatibility

Example:

```json
{
  "runtime": {
    "provider": "openai",
    "model": "gpt-5"
  },
  "compatibleProviders": ["anthropic", "openai"]
}
```

This enables:
- warning if a required provider is unavailable
- suggesting compatible substitutions
- importing the same tuned behavior across different runtime setups

---

## Relationship to Templates

Templates and shared agents are related, but not identical.

### Templates

Best for:
- scaffolding
- onboarding
- generalized starting points

### Shared agents

Best for:
- tuned working configurations
- reusable specialists
- community-curated operational patterns

A useful long-term model may be:
- templates are starter content
- shared agents are evolved, proven content

---

## Safety and Trust

### Risks

- malicious prompt content
- dangerous container mounts
- hidden environment assumptions
- overly expensive default models

### Mitigations

At install time:
- show manifest clearly
- show runtime/provider expectations
- show mounts and task definitions
- require explicit approval for risky config

Community registries may later add:
- verified publishers
- ratings
- install counts
- moderation

---

## Migration Path

### Phase 1: Export/import format

1. define manifest format
2. support local export
3. support local install from folder

### Phase 2: Registry-backed install

1. support git-backed package source
2. browse and install into local project
3. keep local ownership after install

### Phase 3: Provenance and updates

1. store source/version metadata
2. check upstream for updates
3. preview and apply diffs

### Phase 4: Community UX

1. search/filter/tag browsing
2. curated collections
3. ratings/trust signals

---

## Recommendation

The right first framing is:

**shared agents are installable, versioned local copies**

Not:

**shared agents are live remote dependencies**

That keeps the model understandable and respects how much customization tuned agents usually need.

This feature would pair especially well with:
- per-agent runtime selection
- group-owned tasks
- orchestrator automation rules
- future agent-definition management in the UI

Together, those would turn agents from one-off local chats into portable, shareable building blocks for real multi-agent systems.
