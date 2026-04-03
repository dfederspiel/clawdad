# Design: Group-Owned Tasks

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

Tasks work well operationally, but the current UI centers them in a top-level Tasks area.

That creates an information architecture mismatch:

- **Group tasks** feel detached from the group that owns them
- **Team schedules** are separated from the agents and prompts they relate to
- **Global tasks** and **group tasks** are mixed into the same primary surface

In practice, most scheduled work belongs to a specific team or group:
- a project tracker polling Jira
- a writer publishing weekly summaries
- a reviewer checking PRs

Those tasks make more sense in the group drawer/settings surface than in a global admin panel.

## Design Principle

**Tasks should live where ownership lives.**

- Group-owned tasks belong in the group UI
- Global/system tasks belong in the top-level Tasks area

The current top-level Tasks area should remain useful, but as an overview/admin surface, not the primary place users manage team schedules.

---

## Goals

- Make group tasks visible and manageable from the group drawer/settings
- Preserve a top-level Tasks view for global/system-wide work
- Reduce context switching between "agents" and "their schedules"
- Keep the existing task model and scheduler intact where possible

## Non-Goals

- Rewriting the scheduler backend
- Changing task execution semantics in the first phase
- Introducing per-agent task ownership immediately

---

## Current State

### Data model

Tasks are already group-owned in the database:

```typescript
interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  ...
}
```

This is the key point: the backend model already aligns with group ownership.

### Current UI

- Top-level Tasks panel fetches all tasks
- Tasks are grouped visually by `group_folder`
- Group settings do not yet surface task management

So the system is already partway there. The issue is mostly UX placement and control surfaces, not backend ownership.

---

## Proposed UX Model

### Group Drawer / Group Settings

Each group gets a `Tasks` section that shows:

- active tasks for this group
- paused tasks for this group
- next run time
- recent run status
- create/edit/pause/resume/cancel controls

This becomes the default place to manage tasks tied to that group.

### Top-Level Tasks Area

The top-level Tasks surface remains, but changes role.

It becomes:

- a global overview of all scheduled work
- a home for system/global tasks not tied to a user-facing group
- an admin/debugging surface for cross-group visibility

This means:
- group task creation should happen primarily from the group drawer
- the top-level Tasks panel should emphasize filtering, overview, and exceptions

---

## Ownership Model

### Phase 1: Group-owned vs global

Treat tasks as one of two categories:

#### 1. Group-owned task

```json
{
  "group_folder": "web_project-tracker",
  "chat_jid": "web:project-tracker"
}
```

Shown in:
- that group's drawer/settings
- global Tasks overview

#### 2. Global/system task

A task whose `group_folder` points at a system/admin group such as:
- `main`
- `global`
- another explicit system folder

Shown in:
- top-level Tasks area
- optionally hidden from standard group UI

### Future Phase: Agent-owned task

Eventually tasks may be scoped more precisely:

```typescript
interface ScheduledTask {
  ...
  group_folder: string;
  agent_id?: string;
}
```

That would allow:
- a task owned by a specific agent in a multi-agent team
- agent-level schedule views inside the group drawer

But this should come after the group-owned task UX is fixed.

---

## UI Changes

### Group Settings

Add a `Tasks` section alongside:
- subtitle
- notification settings
- agents

This section should show only tasks where:

```text
task.group_folder === group.folder
```

### Task interactions in group settings

Recommended first-pass controls:

- list tasks
- pause/resume
- cancel
- inspect recent logs

Optional in phase 1:
- create task
- edit schedule/prompt inline

### Top-Level Tasks Panel

Refocus the panel around:

- All Tasks
- Global Tasks
- Attention Needed

Potential filters:
- all
- global only
- failed recently
- paused

This makes it feel like an operations dashboard instead of the only place tasks exist.

---

## Why This Fits The Existing Architecture

This codebase already stores tasks by `group_folder`, and the current TaskManager already groups by folder in the UI.

That means the conceptual migration is mostly:

1. surface per-group task slices in the group drawer
2. reframe the global tasks panel as an overview

The scheduler, DB schema, and queue model can mostly stay unchanged in the first phase.

---

## Backend Changes

### Minimal first phase

No DB schema changes required.

The backend already supports:
- create task with `group_folder`
- fetch all tasks
- fetch logs
- pause/resume/cancel

Helpful additions:

- `GET /api/groups/:folder/tasks`
- `GET /api/groups/:folder/tasks/:id/logs`

These are convenience APIs, not data-model changes.

### Why add group-scoped endpoints?

Even though the frontend can filter all tasks client-side, group-scoped endpoints:

- make the ownership model explicit
- reduce payloads
- simplify future auth boundaries
- make the UI easier to reason about

---

## Frontend Changes

### GroupSettings.js

Add:

- `groupTasks = tasks.value.filter((t) => t.group_folder === group.folder)`

Render a `Tasks` section below `Agents`.

### TaskManager.js

Keep the component, but rename its role conceptually:

- current role: primary task management
- future role: cross-group overview

Potential later rename:
- `TaskOverview`

### App state

Current global `tasks` signal can remain.

No immediate state-model rewrite is necessary.

---

## Migration Path

### Phase 1: Surface group tasks in the drawer

1. Add group task section to group settings
2. Filter existing global tasks state by `group.folder`
3. Keep top-level Tasks panel unchanged

Result:
- no backend migration
- immediate UX improvement

### Phase 2: Add group-scoped task APIs

1. Add `/api/groups/:folder/tasks`
2. Load group tasks directly in the drawer
3. Move task creation entrypoint into the group UI

Result:
- clearer ownership model
- cleaner separation between group and global task surfaces

### Phase 3: Reframe top-level Tasks area

1. Rename/reposition as overview/admin
2. Add filters for global vs group-owned tasks
3. Add attention/failure summaries

### Phase 4: Optional agent-owned tasks

1. Add `agent_id` to tasks
2. Show tasks under specific agents within the group
3. Allow coordinator vs specialist schedules to be distinguished

---

## Risks

### 1. Duplicate controls

If both the group drawer and top-level Tasks panel expose full task editing, users may be unsure which is canonical.

Mitigation:
- make the drawer the primary management surface for group tasks
- make the top-level panel overview-first

### 2. Global/system task ambiguity

Some tasks may not map cleanly to a user-visible group.

Mitigation:
- explicitly define system groups as the home for global tasks
- keep them in the top-level panel

### 3. Agent ownership complexity

If agent-owned tasks are introduced too early, the UI may become confusing.

Mitigation:
- start with group-owned tasks only
- defer agent scoping until provider/runtime work clarifies agent-level control surfaces

---

## Recommendation

The scheduler model is already group-shaped. The UI should catch up.

The right near-term move is:

- put group tasks into the group drawer/settings
- keep top-level Tasks as a global overview/admin surface

This aligns task management with how users already think about agents and teams:

**group = agents + prompts + schedules**

That makes the drawer a much more natural home for team behavior, and reduces the feeling that scheduling is a separate subsystem.
