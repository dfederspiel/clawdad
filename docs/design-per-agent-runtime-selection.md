# Design: Per-Agent Runtime Selection

**Status:** Proposal
**Date:** 2026-04-03
**Updated:** 2026-04-03

## Problem

Today, the orchestrator is multi-agent, but the execution runtime is effectively single-provider:

- Agents run through the Claude Agent SDK
- Credentials, health checks, and onboarding are Anthropic-shaped
- `CLAUDE_MODEL` can be overridden for proxy routing, but the runtime still assumes Claude semantics

This creates three product limits:

- **Quota fragility** — when Anthropic quota is exhausted, the platform becomes unavailable
- **No model specialization** — you can't assign cheaper/faster/stronger models to different roles in a team
- **No local/offline path** — Ollama can exist as a tool, but not as a first-class agent runtime

The next logical step for teams is not just "support OpenAI", but:

**Agents in the same group should be able to run different runtimes and models.**

Examples:
- coordinator on a cheap fast model
- researcher on GPT
- writer on Opus
- summarizer on a local Ollama model

## Design Principle

**Runtime selection belongs to the agent.**

Groups own shared chat, memory, and tasks. Agents own execution identity:
- instructions
- trigger
- runtime provider
- model
- provider-specific execution settings

Global defaults still matter, but they are defaults, not the source of truth.

---

## Goals

- Add first-class support for multiple model providers
- Allow different agents in the same group to use different providers/models
- Preserve the current group/chat/task orchestration model
- Keep backward compatibility for existing Anthropic-based groups
- Create a clean path for OpenAI and Ollama without hardcoding provider logic all over the stack

## Non-Goals

- Replacing Claude Code as the admin/developer tool
- Making every provider feature-identical on day one
- Building full provider switching in one step without staged rollout
- Eliminating Anthropic-specific optimizations immediately

Related standard:

- [design-provider-sdk-integration-standards.md](design-provider-sdk-integration-standards.md) defines the required adapter boundary, fallback behavior, and test bar for each provider SDK/runtime integration.

---

## Concepts

### Runtime

A runtime is the execution backend for an agent.

It defines:
- how prompts are sent
- how tool calls are executed
- how sessions are resumed
- how usage is reported
- how credentials are injected

### Provider

A provider is the model source behind a runtime:
- `anthropic`
- `openai`
- `ollama`

In the future this could also include:
- `litellm`
- `openrouter`
- `azure-openai`

### Execution Profile

An execution profile is the runtime config attached to an agent:
- provider
- model
- provider-specific endpoint/auth config
- optional execution settings like temperature or timeout caps

---

## Folder Structure

### Today

```text
groups/
  web_general/
    agents/
      researcher/
        CLAUDE.md
        agent.json
```

### Proposed

```text
groups/
  web_general/
    group-config.json
    agents/
      researcher/
        CLAUDE.md
        agent.json
      writer/
        CLAUDE.md
        agent.json
```

### agent.json

```jsonc
{
  "displayName": "Research Agent",
  "trigger": "@researcher",

  // Existing override bucket
  "containerConfig": {
    "timeout": 600000
  },

  // New
  "runtime": {
    "provider": "openai",
    "model": "gpt-5"
  }
}
```

### Local model example

```jsonc
{
  "displayName": "Local Summarizer",
  "trigger": "@local",
  "runtime": {
    "provider": "ollama",
    "model": "llama3.2"
  }
}
```

### Backward compatibility

If `runtime` is absent:
- provider defaults to `anthropic`
- model defaults to existing `CLAUDE_MODEL` behavior or runtime default

This keeps all current agents working unchanged.

---

## Type Changes

### Agent

Today:

```typescript
interface Agent {
  id: string;
  groupFolder: string;
  name: string;
  displayName: string;
  trigger?: string;
  containerConfig?: ContainerConfig;
}
```

Proposed:

```typescript
type RuntimeProvider = 'anthropic' | 'openai' | 'ollama';

interface AgentRuntimeConfig {
  provider: RuntimeProvider;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

interface Agent {
  id: string;
  groupFolder: string;
  name: string;
  displayName: string;
  trigger?: string;
  containerConfig?: ContainerConfig;
  runtime?: AgentRuntimeConfig;
}
```

### Effective runtime resolution

Runtime config should resolve in this order:

1. `agent.json.runtime`
2. `group-config.json.defaultRuntime`
3. global `.env` defaults
4. hardcoded fallback: `anthropic`

This lets teams set a default provider/model while still overriding per agent.

---

## Runtime Architecture

### Problem with current design

Today the orchestrator is provider-agnostic at the message-routing layer, but the actual execution path is not:

- `container/agent-runner/src/index.ts` imports `@anthropic-ai/claude-agent-sdk`
- `src/container-runner.ts` injects Anthropic env vars and credential proxy assumptions
- `src/credential-proxy.ts` only understands Anthropic auth modes

This means "supporting OpenAI" is not just an `.env` change.

### Proposed execution boundary

Introduce an execution abstraction at the agent-runner layer:

```typescript
interface RuntimeAdapter {
  run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent>;
}
```

Where:

```typescript
interface RuntimeRunInput {
  prompt: string | AsyncIterable<SDKUserMessage>;
  sessionId?: string;
  runtime: EffectiveRuntimeConfig;
  cwd: string;
  additionalDirectories?: string[];
  systemPrompt?: string;
  allowedTools: string[];
  env: Record<string, string>;
}

type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input?: Record<string, unknown> }
  | { type: 'result'; result: string | null; sessionId?: string }
  | { type: 'usage'; usage: NormalizedUsageData }
  | { type: 'error'; error: string };
```

### Adapter implementations

#### 1. AnthropicAdapter

Wraps the existing Claude SDK path.

Benefits:
- lowest-risk migration
- existing behavior preserved
- current session and tool behavior remain intact

#### 2. OpenAIAdapter

New runtime implementation for OpenAI models.

Responsibilities:
- submit prompts/messages
- manage tool calling
- normalize usage/cost/session state
- translate OpenAI responses into shared runtime events

#### 3. OllamaAdapter

Local runtime for host-accessible Ollama models.

Important constraint:
- Ollama may not support the same tool/session semantics as cloud providers
- first version can prioritize direct response tasks over full parity

---

## Session Model

### Today

Sessions are effectively Claude sessions, already isolated per agent:
- `data/sessions/{group_folder}/{agent_name}/.claude/`

### Proposed

Sessions remain isolated per agent, but provider/runtime ownership must be explicit.

Add a runtime fingerprint to session identity:

```typescript
sessionKey = `${agentId}:${provider}:${model}`
```

Why:
- resuming an Anthropic Claude session as an OpenAI session is invalid
- changing a model may invalidate provider-specific continuation semantics

### Migration rule

Existing session keys continue to map to:
- `provider = anthropic`
- `model = current default`

When an agent changes provider/model:
- old session is preserved but no longer resumed
- a new session starts under the new runtime fingerprint

---

## Credential Model

### Today

There are two credential paths:

- Anthropic reverse proxy
- generic `/forward` substitution proxy for service credentials

### Proposed

Split credential handling into provider-aware resolution.

#### Provider credentials

Examples:
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `OLLAMA_BASE_URL` or host-local socket/HTTP endpoint

#### Generic service credentials

Keep `/forward` as-is for GitHub/Jira/etc.

### Provider registry

Introduce a provider credential resolver:

```typescript
interface ProviderCredentials {
  provider: RuntimeProvider;
  apiKey?: string;
  oauthToken?: string;
  baseUrl?: string;
}
```

This prevents `credential-proxy.ts` from remaining Anthropic-specific forever.

### Important design choice

Do not force OpenAI through Anthropic-shaped env vars long term.

A compatibility path can help during rollout, but first-class support should expose:
- OpenAI-native credential names
- OpenAI-native health checks
- OpenAI-native onboarding UI

---

## Container Runner Changes

### Today

`src/container-runner.ts` injects:
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_API_KEY=placeholder` or `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
- optional `CLAUDE_MODEL`

### Proposed

Container env wiring should depend on the agent's effective runtime:

#### Anthropic
- preserve existing behavior

#### OpenAI
- inject `OPENAI_API_KEY=placeholder`
- inject `OPENAI_BASE_URL` when configured
- do not require Anthropic proxy semantics

#### Ollama
- inject `OLLAMA_HOST` / `OLLAMA_BASE_URL`
- no cloud credential proxy required

### Transitional option

During rollout, OpenAI could optionally run through a compatibility endpoint if needed.

But the container runner should already be shaped like:

```typescript
buildRuntimeEnv(runtime: EffectiveRuntimeConfig): string[]
```

instead of inlining Anthropic assumptions into the main run path.

---

## Web UI Changes

### Group Settings / Agent Editor

Each agent should expose runtime settings:
- provider dropdown
- model field/dropdown
- optional provider-specific endpoint

Example:

- Provider: `Anthropic | OpenAI | Ollama`
- Model: `claude-sonnet`, `gpt-5`, `llama3.2`

### Group defaults

Optional group-level default runtime:

```json
{
  "defaultRuntime": {
    "provider": "openai",
    "model": "gpt-5-mini"
  }
}
```

This reduces friction when a whole team mostly uses the same provider.

### Onboarding / Setup

Health and setup should become provider-aware:

- Anthropic configured?
- OpenAI configured?
- Ollama reachable?

Rather than a single "Anthropic configured?" gate.

---

## Usage and Telemetry

### Today

Usage is normalized around Claude SDK outputs:
- input tokens
- output tokens
- cache tokens
- cost
- turns

### Proposed

Keep a normalized telemetry shape, but allow provider-specific missing fields.

```typescript
interface NormalizedUsageData {
  provider: RuntimeProvider;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  durationMs: number;
  numTurns: number;
}
```

Provider differences:
- Anthropic: cache fields available
- OpenAI: cache fields likely absent
- Ollama: cost often `0` or undefined; token counts may be approximate

### DB changes

Add to `agent_runs`:
- `provider TEXT`
- `model TEXT`

This is essential if mixed-model teams are a product feature.

---

## Health Checks

### Today

Health is Anthropic-oriented:
- Anthropic credential present?
- container image built?

### Proposed

Health becomes capability-oriented:

```typescript
interface ProviderHealth {
  provider: RuntimeProvider;
  status: 'configured' | 'missing' | 'unreachable';
  models?: string[];
  error?: string;
}
```

Examples:
- Anthropic configured
- OpenAI configured
- Ollama reachable with models installed

The web setup flow can then offer:
- choose a default provider
- connect another provider later

---

## Migration Path

### Phase 1: Config abstraction

Goal: make the codebase provider-aware without changing execution yet.

1. Add `runtime` to `agent.json`
2. Extend `Agent` type and discovery
3. Add provider/model fields to usage records
4. Add provider-aware health/config structures
5. Keep all execution routed to Anthropic initially

### Phase 2: Runtime interface

Goal: separate orchestration from provider execution.

1. Introduce `RuntimeAdapter`
2. Wrap current Claude SDK path as `AnthropicAdapter`
3. Move Anthropic-specific logic out of the generic runner

### Phase 3: OpenAI adapter

Goal: first cloud alternative.

1. Implement OpenAI runtime adapter
2. Normalize tool calls and usage
3. Add provider selection to UI
4. Allow per-agent model/provider settings

### Phase 4: Ollama adapter

Goal: local model path.

1. Add Ollama runtime adapter
2. Add host reachability checks
3. Expose local models in the UI
4. Document capability limitations clearly

### Phase 5: Full productization

1. Group default runtime settings
2. Template/runtime presets
3. Cost-aware recommendations
4. Team-level mixed-provider dashboards

---

## Risks

### 1. Tool parity

Anthropic and OpenAI may expose tool calling differently.

Mitigation:
- normalize at adapter boundary
- accept reduced parity initially for some providers

### 2. Session semantics differ

Claude-style session resume may not map cleanly to OpenAI/Ollama.

Mitigation:
- version session keys by provider/model
- avoid pretending session continuity is interchangeable

### 3. Product complexity

Provider/model choice can overwhelm users.

Mitigation:
- keep defaults simple
- expose advanced settings only in agent edit surfaces

### 4. Docs and setup drift

The current docs assume Anthropic everywhere.

Mitigation:
- provider-aware setup docs must ship with the feature

---

## Recommendation

The right framing is not:

**"Add OpenAI support."**

It is:

**"Make runtime selection a first-class per-agent capability."**

That gives:
- OpenAI support
- future Ollama support
- mixed-model teams
- cost and capability specialization inside a single group

This aligns with the existing multi-agent direction of the codebase and uses the new `Agent` abstraction as the correct ownership boundary.

---

## Concrete Change Points

Likely files/modules to change first:

- `src/types.ts`
  Add `RuntimeProvider` and `AgentRuntimeConfig`
- `src/agent-discovery.ts`
  Parse `runtime` from `agent.json`
- `src/container-runner.ts`
  Replace Anthropic-specific env injection with provider-aware env builders
- `container/agent-runner/src/index.ts`
  Introduce runtime adapter boundary
- `src/credential-proxy.ts`
  Split Anthropic-specific logic from generic provider credential resolution
- `src/health.ts`
  Make health provider-aware
- `src/channels/web.ts`
  Replace Anthropic-only registration/onboarding endpoints with provider-aware ones
- `web/js/components/GroupSettings.js`
  Add per-agent runtime controls

## Open Questions

1. Should OpenAI use a direct adapter first, or a compatibility proxy as a transitional step?
2. Should runtime defaults live in `.env`, `group-config.json`, or both?
3. How much tool parity is required before Ollama counts as a first-class agent runtime?
4. Do we want provider selection only in advanced settings at first, or visible in the default create/edit flow?
