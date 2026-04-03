# Design: Private Agent Workspaces

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

As groups gain more agents, there is a growing need to work with a single agent directly.

Examples:

- tuning an agent's behavior
- testing edge cases privately
- coaching an agent without adding noise to the team thread
- debugging why an agent handled a task a certain way
- refining prompts, triggers, and runtime choices

Today, the main interaction surface is the shared group chat. That is good for collaboration, but it is not ideal for focused agent-specific work.

## Proposal

Allow clicking an agent inside a group to open a **private workspace** for that agent.

This should feel like:

- a direct one-on-one chat with the agent
- scoped to that specific agent
- separate from the shared team chat

The private workspace becomes the place for:

- training
- tweaking
- experiments
- prompt validation
- behavior debugging

## Design Principle

**Shared team collaboration and private agent tuning are different modes.**

They should be connected, but not conflated.

## Goals

- Let users work directly with a single agent from within a team
- Reduce noise in shared group chats
- Make agent tuning and validation easier
- Create a natural home for future per-agent settings and prompt inspection

## Non-Goals

- Replacing the shared team chat
- Making private conversations automatically rewrite the live agent prompt
- Building a full training/evaluation system in phase 1

## Why This Matters

Once agents become meaningful teammates, users will naturally expect to click into one and work with it directly.

That is especially true for:

- specialists with distinct roles
- agents that need careful tuning
- teams with mixed providers/models later on

Without a private workspace, the user has to choose between:

- polluting the team thread with agent-training chatter
- or leaving the UI to edit files manually

Neither is a great fit.

## User Experience

### Entry point

From a group:

- click an agent avatar/name in the drawer
- click an agent in the group settings
- later, click an agent badge from a message header

### Result

Open a private chat/workspace for that agent.

This workspace should show:

- agent name and display name
- owning group/team
- trigger
- private chat history with that agent

Future additions:

- prompt/instructions viewer
- editable agent config
- runtime/provider/model selector
- recent activity and delegation history
- test prompts and eval harnesses

## Mental Model

The same agent has two modes of participation:

### 1. Team mode

The agent participates in the shared group chat as part of the team.

### 2. Private mode

The user works directly with the agent in a private workspace.

Important:

- the agent identity is the same
- the conversation context is different
- histories should remain separate

## Recommendation

Treat this as a distinct **agent workspace**, not just a DM.

That framing creates room for:

- private chat
- prompt inspection
- configuration
- runtime tuning
- debugging tools

without overloading the main group chat UI.

## Data Model Direction

Private workspaces should be separate chat identities or session contexts.

They should not simply reuse the shared group JID.

Possible shape:

```typescript
interface AgentWorkspace {
  id: string;
  groupJid: string;
  agentId: string;
  mode: 'private';
}
```

Important properties:

- private history is separate from team history
- team orchestration remains separate from private experimentation
- an agent can still be understood as belonging to a group

## Prompt and Config Boundaries

This is the main area to be careful with.

Private interaction should not automatically mean:

- "the agent has now been retrained"
- "the live team prompt changed"
- "future group behavior is different"

Those mutations should be explicit.

Recommendation:

- private chat is safe by default
- edits to `CLAUDE.md`, `agent.json`, runtime, or trigger should require explicit save actions
- the UI should make it clear when a change affects the live team behavior

## Relationship to Other Roadmap Items

This concept fits naturally with:

- per-agent runtime selection
- prompt visibility/editing
- shared agent registry
- work-state telemetry
- group-owned tasks and automation rules

It is a good "surface area" feature because it gives users a place to interact with all those deeper capabilities later.

## Phase 1 Recommendation

Keep the first version small:

1. allow clicking an agent to open a private chat
2. keep the chat history separate from the team thread
3. show basic agent metadata in the header
4. do not automatically mutate prompt/config from chat content

That alone would provide a lot of value.

## Phase 2

Add agent workspace utilities:

- prompt viewer
- edit/save flow for instructions
- trigger editing
- display name editing
- runtime/model selection

## Phase 3

Add more advanced tuning features:

- compare private behavior vs team behavior
- save prompt revisions
- eval/test cases
- import/export/share the tuned agent

## Risks

### 1. Confusing private chat with live training

Users may assume that chatting privately changes the agent's future behavior automatically.

Mitigation:

- make prompt/config mutation explicit
- label unsaved vs saved changes clearly

### 2. Identity confusion

Users may not know whether they are talking to:

- the agent as part of the team
- or a separate private clone

Mitigation:

- keep the same agent identity
- make the mode visually explicit: `Private Workspace`

### 3. Context leakage

Private chats should not accidentally pollute shared team context unless explicitly intended.

Mitigation:

- separate histories and sessions
- explicit "apply to team" actions later

## Recommendation Summary

Yes, this is a strong feature idea.

The best framing is:

- not just "open a DM"
- but "open a private workspace for this agent"

That gives users a focused place for:

- training
- tuning
- testing
- debugging

while preserving the clarity of the shared team thread.
