# Plan: Provider-Aware Multimodal Image Input

**Status:** Proposal
**Date:** 2026-04-09
**Updated:** 2026-04-09

## Problem

ClawDad can now:

- show agent-published screenshots inline in web chat
- accept user image uploads and paste events
- store media artifacts in a durable host-managed pipeline

But the execution layer still treats user input as text-only.

Today, uploaded images help mainly because:

- the user can see them in chat
- the agent gets a file path like `/workspace/group/uploads/...`
- tools can inspect the image indirectly

That is useful, but it leaves model capability on the table. A multimodal-capable model should be able to directly inspect the image in the turn where it matters.

At the same time, ClawDad is moving toward per-agent runtime/provider selection. That means image input cannot be designed as an Anthropic-only path. Different providers and models have different multimodal semantics, limits, and transport formats.

## Design Principle

**Model-visible media should be a provider-aware capability, not a provider-specific special case.**

ClawDad should own:

- the canonical media artifact model
- the message/attachment model exposed to orchestration
- the fallback rules when a runtime cannot consume a given attachment

Each runtime should own only:

- how those attachments are encoded for that provider
- what limits or restrictions apply
- whether the target model can actually consume them

## Why this is a high-leverage upgrade

True multimodal input would improve:

- screenshot debugging
- browser automation feedback loops
- design review and mockup iteration
- visual document understanding
- user trust when the conversation is about what is on screen

This is not just a UX feature. It is a capability upgrade that makes agent reasoning better on the exact tasks ClawDad is increasingly good at.

## Constraint: providers are not alike

As of April 9, 2026, the broad provider picture is:

- **Anthropic**: official vision support exists in the Messages/API layer and is a natural fit for image input.
- **OpenAI**: official multimodal input exists in the Responses/API layer.
- **Ollama**: vision support exists, but model support is local-model-dependent and less uniform.
- **GitHub Copilot**: GitHub documents that some Copilot models support multimodal inputs, but availability varies by client, plan, and model.

So the platform should never assume:

- all providers accept the same image formats
- all models on a provider are multimodal
- all runtimes accept the same request shape
- image input cost/latency behaves similarly everywhere

## Recommendation

Implement multimodal input in four layers.

### 1. Canonical attachment model in ClawDad

Add a provider-neutral input attachment shape at the orchestration layer.

Example:

```ts
interface InputAttachment {
  id: string;
  artifactId: string;
  kind: 'image';
  mimeType: string;
  localPath: string;
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  source: 'user_upload' | 'agent_browser' | 'agent_output';
}
```

Messages should be able to carry:

- plain text
- structured attachments
- both together

This should exist before provider encoding begins.

### 2. Runtime capability negotiation

Each runtime should expose capabilities instead of pretending feature parity.

Example:

```ts
interface RuntimeCapabilities {
  textInput: true;
  imageInput: boolean;
  pdfInput: boolean;
  maxImagesPerTurn?: number;
  acceptedImageMimeTypes?: string[];
  supportsRemoteUrls?: boolean;
  supportsLocalFiles?: boolean;
}
```

And:

```ts
interface AgentRuntime {
  getCapabilities(): RuntimeCapabilities;
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
}
```

This lets the orchestrator make decisions like:

- inline the image into the model request
- send text plus file-path fallback only
- warn the user that the chosen agent/model cannot directly inspect images

### 3. Provider-specific attachment encoders

Create a small encoder layer per runtime.

For example:

- `AnthropicAttachmentEncoder`
- `OpenAIAttachmentEncoder`
- `OllamaAttachmentEncoder`
- later: `CopilotAttachmentEncoder` or `GitHubModelsAttachmentEncoder`

Each encoder converts:

```ts
RuntimeTurnInput {
  systemPrompt,
  messages,
  attachments,
  tools,
}
```

into the provider-native request format.

Important: this is where provider differences belong. They should not leak upward into the queue, chat pipeline, or media artifact model.

### 4. Fallback behavior that stays user-friendly

When a runtime cannot accept image input directly:

- keep the inline image in chat
- preserve the `/workspace/group/uploads/...` path for tools
- add a short internal runtime note like:
  `Image attachment present but this runtime/model does not support direct image input; file path remains available in workspace.`

That preserves usefulness without silently dropping context.

## Proposed Runtime Input Model

The current runner is effectively:

```ts
type RuntimeUserMessage = {
  role: 'user';
  content: string;
};
```

The proposed shape should become:

```ts
type RuntimeInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string };

interface RuntimeMessage {
  role: 'user' | 'assistant';
  content: RuntimeInputPart[];
}

interface RuntimeTurnInput {
  systemPrompt?: string;
  messages: RuntimeMessage[];
  attachments: InputAttachment[];
  threadId?: string;
  agentId: string;
  runtime: {
    provider: string;
    model?: string;
  };
}
```

This keeps text and attachments in the same turn model without locking the top of the stack to one provider API.

## UX behavior

From the user's point of view:

1. user uploads an image or selects one already in chat
2. ClawDad stores the artifact and displays it inline
3. the next agent turn includes that image as direct model input when supported
4. if not supported, the user still sees the image and the agent still gets the file-path fallback

Good UX additions:

- agent/model badge can eventually indicate image-capable vs text-only
- if an image is present but direct vision is unavailable, the UI can show a subtle fallback note
- per-agent settings can later show capability mismatches before the user runs into them

## Phased implementation

### Phase 1: Internal multimodal turn model

Goal: prepare the runner and orchestration layer without changing all runtimes at once.

1. Add `InputAttachment` and `RuntimeTurnInput` types
2. Teach the web channel to attach uploaded images to the next turn context
3. Thread attachment references through queue/orchestrator APIs
4. Keep actual provider execution on text-only fallback initially if needed

### Phase 2: Anthropic path

Goal: first real multimodal runtime.

1. Implement Anthropic image attachment encoding
2. Add runtime capability reporting
3. Add tests for mixed text + image turns
4. Record usage/cost behavior for image-bearing requests

This is the best first target because the current runner is already Anthropic-shaped.

### Phase 3: OpenAI path

Goal: validate that the abstraction is truly provider-neutral.

1. Implement OpenAI attachment encoder
2. Confirm the same ClawDad `RuntimeTurnInput` maps cleanly
3. Compare limits, failure modes, and cost recording

If this phase needs orchestration hacks, the abstraction boundary is wrong and should be adjusted before further rollout.

### Phase 4: Ollama path

Goal: support local multimodal where available.

1. Mark image support as model-dependent
2. Add capability checks per configured local model
3. Keep fallback behavior strong because some Ollama models will be text-only

Ollama should be treated as the most variable provider in this feature area.

### Phase 5: GitHub Copilot / GitHub Models path

Goal: support GitHub-backed multimodal models if and where available.

Because GitHub model access varies by client, plan, and model, this should be capability-driven from day one rather than assumed available.

## Data and telemetry considerations

We should add normalized fields so multimodal turns are observable:

- `attachment_count`
- `image_attachment_count`
- `attachment_bytes_total`
- `runtime_provider`
- `runtime_model`
- `image_input_used` boolean
- `image_input_fallback_reason` optional string

This matters because image-bearing turns may:

- cost more
- run longer
- have different failure patterns

## Important non-goals

- Do not require every provider to reach parity before shipping Anthropic support
- Do not inline provider-specific image payload logic into queue or channel code
- Do not block web image UX improvements on the full multimodal runtime work

## Open questions

1. Should uploaded images automatically attach only to the next user turn, or remain explicitly selectable across multiple future turns?
2. Should agent-published screenshots ever be attachable back into the model automatically, or only when the user explicitly references/selects them?
3. Where should provider/model capability metadata live in the UI: onboarding, agent settings, composer, or all three?
4. Should the runtime adapter accept local file paths only, or should it normalize to bytes/base64 before provider encoding?

## Recommended next step

Before implementation, define one small capability matrix in code and one normalized `RuntimeTurnInput` type. If those two pieces feel clean, the Anthropic multimodal path can be implemented without boxing the future provider work into a corner.
