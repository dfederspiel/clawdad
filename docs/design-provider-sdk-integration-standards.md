# Design: Provider SDK Integration Standards

**Status:** Proposal
**Date:** 2026-04-09
**Updated:** 2026-04-09

## Purpose

ClawDad is moving toward a provider-neutral runtime boundary while keeping a multi-agent orchestration layer, shared chat model, media artifacts, and delivery semantics.

That only works if every SDK or provider integration follows the same rules.

This document is the code of conduct for provider/runtime integrations:

- Anthropic
- OpenAI
- Ollama
- GitHub Copilot / GitHub Models
- Azure OpenAI
- proxy-backed providers like OpenRouter or LiteLLM
- future providers not yet implemented

## Core Rule

**No provider SDK should shape the rest of the system.**

Provider-specific behavior must stop at the runtime adapter boundary.

ClawDad core owns:

- chat and message routing
- delegation semantics
- supersession behavior
- media artifact storage
- fallback behavior
- normalized telemetry
- runtime capability negotiation

The provider adapter owns:

- request encoding
- SDK/client calls
- provider-specific event mapping
- provider-specific usage extraction
- provider-specific limitations and retries

Related design:

- [design-provider-auth-lifecycle.md](design-provider-auth-lifecycle.md) defines the provider-side rules for credential lifecycle, stale auth handling, refresh semantics, and auth health reporting.

## Required integration boundary

Every provider integration must implement the same conceptual contract:

- `AgentRuntimeConfig`
- `RuntimeCapabilityProfile`
- `RuntimeTurnInput`
- `RuntimeEvent`
- `RuntimeSession`

If a provider cannot map cleanly to that contract, the contract should be adjusted deliberately before rollout. Do not bypass it “just for one provider.”

## Rules for provider adapters

### 1. Never leak provider-native request shapes upward

Bad:

- queue logic building Anthropic message content
- web channel deciding OpenAI image encoding
- orchestrator checking provider-specific error strings directly

Good:

- provider adapter receives normalized `RuntimeTurnInput`
- provider adapter returns normalized `RuntimeEvent`

### 2. Capabilities are resolved, not assumed

Agents declare desired runtime config:

- provider
- model
- endpoint/settings

The runtime resolves actual capabilities:

- image input
- tool use
- streaming
- session resume
- local file vs URL handling

The runtime adapter is the source of truth for effective capability, not agent config alone.

### 3. Fallback behavior is mandatory

If a runtime cannot support a feature directly, it must fail soft where possible.

Examples:

- image present but no native vision support → preserve chat image, pass file-path fallback, record fallback reason
- no session resume support → adapt with stateless continuation behavior where possible
- partial tool support → expose capability mismatch early, not mid-run if avoidable

Silently dropping context is not acceptable.

### 4. Usage and telemetry must be normalized

Every adapter must map provider usage into the same normalized shape where possible:

- input tokens
- output tokens
- cache read/write tokens if applicable
- cost
- duration
- turn count
- attachment-related metadata when multimodal is used

If a provider does not expose a field, omit or zero it explicitly. Do not invent incompatible semantics.

### 5. Errors must be translated

Provider-native error formats should be translated into a small stable set of categories where possible:

- auth
- quota
- rate_limit
- capability_mismatch
- bad_request
- transport
- provider_unavailable
- internal_runtime_error

The raw provider error can still be logged, but the orchestrator should not depend on vendor-specific message parsing.

### 6. Session semantics must be explicit

Providers differ heavily here.

Each adapter must document whether session behavior is:

- native
- adapter-managed
- unsupported

The rest of the system must not assume all providers can resume or continue in the same way Anthropic currently can.

### 7. Tool support must be honest

If a runtime cannot support the full tool model:

- say so in capabilities
- degrade predictably
- do not pretend partial emulation is equivalent unless it actually is

Tool calling is a capability boundary, not marketing copy.

### 8. Tests must include fallback and mismatch cases

Every provider integration should be tested for:

- supported happy path
- unsupported feature path
- capability mismatch surfaced clearly
- usage extraction
- streaming event translation
- auth failure
- transport failure

For multimodal runtimes specifically:

- text-only turn
- text + image turn
- image present but unsupported model
- multiple images if supported

## Required docs for a new provider

Before a provider is considered integrated, it should have:

1. capability profile
2. auth/credential expectations
3. session semantics note
4. known unsupported features
5. fallback behavior description
6. test plan

If those are not written down, the provider is experimental, not integrated.

## Recommended rollout order for a new provider

1. Add types and capability profile
2. Add adapter stub
3. Add credential/health wiring
4. Pass smoke tests for text-only turns
5. Add usage normalization
6. Add multimodal/tool support if applicable
7. Test in a mixed-provider team
8. Only then expose broadly in UI defaults

## Testing expectations

We should test providers at three levels.

### 1. Contract tests

Provider adapter should satisfy:

- `RuntimeTurnInput` in
- `RuntimeEvent` stream out
- normalized result/usage semantics

These tests should not depend on the rest of the orchestrator.

### 2. Integration tests

Run a real or fixture-backed turn through the container runner and ensure:

- config resolution works
- capabilities are surfaced
- errors normalize correctly
- fallback behavior is visible

### 3. Mixed-team tests

Use realistic combinations such as:

- Ollama triage + Anthropic specialist
- OpenAI coordinator + Anthropic browser specialist
- Copilot coding agent + Anthropic coordinator

This is where hidden provider assumptions tend to show up.

## Special note on proxies

OpenRouter and LiteLLM should be treated as transport/proxy layers, not capability authorities.

Their adapters should:

- report capability as proxy-dependent unless proven otherwise
- avoid pretending every routed upstream model has the same behavior
- preserve underlying model/provider identity where available for telemetry

## Definition of “supported”

A provider/runtime should be called supported only when:

- it has a documented capability profile
- it passes contract tests
- it passes at least one live integration path
- it has explicit fallback behavior
- its known limitations are visible in docs or UI

Everything else should be labeled experimental.

## Recommendation

Use this document as the checklist for every new runtime adapter. The immediate next consumer should be the Anthropic adapter extraction itself: if we cannot isolate the current Claude SDK path behind these rules, the boundary is not strong enough yet.
