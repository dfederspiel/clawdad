# Design: Browser Snapshots And Rich Media Chat

**Status:** Proposal
**Date:** 2026-04-08
**Updated:** 2026-04-08

## Problem

ClawDad already gives agents browser automation through the `agent-browser` container skill. In practice, that means agents can:

- browse pages
- interact with UI
- take screenshots
- save PDFs and state

But the product does not yet treat screenshots or images as first-class conversation objects.

Today:

- browser automation is available inside the container
- screenshots are files on disk
- the chat model is still basically text plus structured JSON blocks
- the web UI does not surface browser screenshots as a native part of the conversation
- users cannot easily respond to a specific image in-thread as feedback context

That creates a gap between what agents can do and what users can see.

### Why this matters

If an agent is using browser automation, screenshots are often the most useful artifact:

- "Here’s what I’m seeing"
- "Is this the right button?"
- "This page looks broken"
- "Which of these layouts do you want?"
- "I reached the login wall"

Without first-class image handling, the agent either:

- describes the page in text
- writes a screenshot to disk but never shows it
- asks the user to trust it

That is much worse than a tight visual workflow.

---

## Current State

### Browser skill availability

`agent-browser` is already effectively first-class at the container-skill layer.

In [src/container-runner.ts](/home/david/code/clawdad/src/container-runner.ts), all skills under `container/skills/` are synced into each agent session directory. That means every agent container gets the same installed skills, including:

- `agent-browser`
- `rich-output`
- status/capability helpers

So the answer to "is Playwright/browser automation first-class for all agents?" is:

- **At the skill/runtime layer: yes**
- **At the UX and chat-object layer: not yet**

### Current limitations

1. **No first-class image message model**
   The message schema in [src/types.ts](/home/david/code/clawdad/src/types.ts) stores `content` as text and the UI renders text plus `:::blocks` JSON. There is no attachment/image object model.

2. **No image block type in the web renderer**
   Blocks exist for tables, cards, stats, alerts, diffs, and similar structured content, but not for first-class inline screenshots as chat artifacts.

3. **No screenshot lifecycle**
   There is no standard host-side path for:
   - agent captures screenshot
   - host registers artifact
   - UI shows preview
   - user clicks/selects image
   - user replies with feedback anchored to that image

4. **No inbound image support**
   Users cannot yet upload or paste images into the chat as a first-class prompt artifact for the agent.

---

## Design Principle

**Visual artifacts should be first-class conversation objects, not just files on disk.**

That means:

- browser screenshots should be visible in the thread
- image delivery should be separate from plain text rendering
- users should be able to respond to images as context
- the architecture should support both agent-generated and user-supplied images

---

## Goals

- Make browser screenshots visible in the web chat thread
- Let agents intentionally surface screenshots when using browser automation
- Support lightweight automatic screenshot bubbling during browser work
- Add first-class image objects to the conversation model
- Support inbound user images in the web UI
- Allow users to select an image and provide contextual follow-up feedback
- Keep the event and message model provider-neutral

## Non-Goals

- Full visual annotation tools in phase 1
- Building a Figma-class canvas or inspector
- Perfect parity across non-web channels in the first pass
- Streaming live video from Playwright sessions

---

## Recommendation

Implement this in three layers:

### Layer 1: First-class image artifacts

Add a durable artifact model for screenshots and other media.

### Layer 2: In-chat image rendering

Teach the web UI and message pipeline to show images directly in the thread.

### Layer 3: Visual feedback loop

Allow users to reply to or select an image as prompt context for the next agent turn.

That gives us a usable short-term workflow while also supporting the richer long-term UX.

---

## Proposed Architecture

## 1. Media Artifact Model

Introduce a host-managed media artifact record.

Example shape:

```typescript
interface MediaArtifact {
  id: string;
  chatJid: string;
  threadId?: string;
  createdAt: string;
  source: 'agent_browser' | 'agent_output' | 'user_upload';
  mediaType: 'image' | 'pdf';
  mimeType: string;
  path: string;
  width?: number;
  height?: number;
  agentName?: string;
  runId?: string;
  batchId?: string;
  caption?: string;
}
```

Store metadata in SQLite and the actual file under a host-managed media directory, for example:

```text
data/media/{chatJid}/{artifactId}.png
```

This avoids treating screenshots as random ad hoc files in `/workspace/group/`.

## 2. Image-capable message objects

Extend the message pipeline so a message can carry structured media references in addition to text.

This can be done in two possible ways:

### Option A: Add native message attachments

Extend `messages` with structured attachment metadata.

Benefits:
- strongest long-term model
- clean separation from markdown/blocks parsing
- better for inbound uploads and non-web channel translation later

Costs:
- broader schema and API changes

### Option B: Add image blocks first

Introduce an `image` block type inside `:::blocks`.

Example:

```text
:::blocks
[
  {
    "type": "image",
    "artifactId": "art_123",
    "src": "/api/media/art_123",
    "alt": "Screenshot of the billing dashboard",
    "caption": "I found the failing validation state here."
  }
]
:::
```

Benefits:
- fits current web rendering model
- smaller initial change
- works well for agent-generated screenshots

Costs:
- weaker long-term model for inbound uploads and multi-channel media support

### Recommendation

Use a staged hybrid:

- **Phase 1:** image block type backed by media artifacts
- **Phase 2:** native attachment model in the API/DB

That gives a fast path without locking the system into blocks forever.

## 3. Browser screenshot surfacing

Add an explicit path for screenshot publication.

Two modes:

### Explicit publish

The agent intentionally says:

- "Here is the screenshot"
- "Please look at this state"
- "I’m blocked on this screen"

Mechanically:

1. `agent-browser screenshot` saves file
2. host or tool wrapper registers artifact
3. agent emits an image block referencing the artifact

### Automatic bubbling

For certain browser workflows, screenshots should auto-surface to the UI.

Examples:
- user asks "show me what you see"
- agent enters a browser-inspection flow
- agent hits an error state or ambiguous page
- debug mode / calibration mode

This should be controlled by policy, not done for every browser action.

Suggested modes:

- `manual` — only show screenshots when agent explicitly publishes them
- `on_request` — auto-show when user asked for screenshots or visual debugging
- `debug` — auto-show key screenshots during browser work

---

## UX Proposal

## Phase 1 UX: In-thread image cards

When an agent surfaces a screenshot, the message appears inline in the thread:

- image preview
- caption
- agent name / timestamp
- click to open larger lightbox/modal

If the agent includes both prose and image blocks, they interleave naturally.

### Example

```text
I found the bug. The validation error appears after clicking Save.

[screenshot preview]
Caption: "The form stays disabled after the API succeeds."
```

## Phase 2 UX: Select image and reply with context

From the image card or modal, the user can:

- reply to this image
- use image as context for next message
- mark a region later (optional future enhancement)

The next user message then carries:

- text input
- referenced `artifactId`

Example:

```typescript
interface UserMessageContext {
  selectedArtifactIds?: string[];
}
```

This enables prompts like:

- "This is the wrong modal"
- "Use the second screenshot, not the first"
- "The button I mean is the top-right one"

## Phase 3 UX: Browser activity + snapshot strip

When browser automation is active, the UI can show:

- current work-state summary
- latest screenshot preview(s)
- recent browser activity entries

This fits naturally with the existing activity-feed and work-state roadmap.

---

## Integration With Existing Systems

## Work-state / activity feed

Screenshot creation should produce activity events such as:

```typescript
type AgentProgressEvent =
  | { type: 'browser_snapshot'; artifactId: string; summary?: string }
```

This allows:

- live snapshot bubbling while a run is in progress
- persistent activity history later

## Delegation and supersession

Images need the same delivery semantics as text:

- an image can be generated but suppressed from user delivery
- a coordinator can still know the artifact exists
- stale browser screenshots should not clutter the thread when newer context supersedes them

So media delivery should integrate with the same lease/supersession policy already used for text delivery.

## Rich output blocks

The existing `rich-output` system is the shortest path to render images in the web UI now.

Add:

- `image`
- possibly `image_gallery` later

to the supported block types and block renderer.

---

## Short-Term Implementation Plan

## Phase 1: Agent-generated screenshots in chat

Goal:
- screenshots visible in the web thread

Changes:
- add media artifact storage + `/api/media/:id`
- add `image` block type to block parser/renderer
- add a documented screenshot-publish pattern for `agent-browser`
- optionally add a helper tool or wrapper to register screenshots cleanly

Success criteria:
- agent can take screenshot
- agent can surface it in thread
- user can view it inline and enlarged

## Phase 2: Automatic bubbling during browser work

Goal:
- screenshots can appear while Playwright/browser automation is active

Changes:
- add browser snapshot progress events
- add work-state/UI hooks for active browser sessions
- support policy modes (`manual`, `on_request`, `debug`)

Success criteria:
- user sees visual evidence during browser work without waiting for the final answer

## Phase 3: Bi-directional image support

Goal:
- users can upload or paste images into chat

Changes:
- web UI file picker / paste support
- inbound media storage and artifact registration
- prompt/context wiring so agent receives selected image references

Success criteria:
- user can send screenshot/mockup/image
- agent can reason over it as conversation context

## Phase 4: Image-anchored feedback

Goal:
- user can select an image already in the thread and respond to it directly

Changes:
- image selection UI
- message composer context chips
- artifact references on outbound user messages

Success criteria:
- "reply to screenshot" becomes a normal workflow

---

## Open Questions

1. Should `agent-browser screenshot` itself register artifacts, or should we add a separate wrapper/tool for publishing screenshots?
2. Should screenshots default to private artifacts unless explicitly surfaced, or auto-publish in some browser modes?
3. Do we want image support only in web first, with graceful text fallback elsewhere?
4. How should agents receive inbound images in the prompt: file path, artifact metadata, or both?
5. Should media artifacts live in the message table directly, or in a separate artifact table linked to messages?

---

## Recommendation Summary

The shortest high-value path is:

1. keep `agent-browser` as the universal browser skill
2. add first-class media artifacts
3. add an `image` rich block for web chat
4. surface screenshots inline in the thread
5. then add inbound image support and image-anchored replies

That gives us a much tighter browser UX quickly, while preserving a clean path toward full rich-media chat.
