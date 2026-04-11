# Design: Provider-Aware Auth Lifecycle

**Status:** Proposal
**Date:** 2026-04-11
**Updated:** 2026-04-11

## Problem

ClawDad is moving toward a provider-neutral runtime boundary, but authentication is still mostly Anthropic-shaped and access-token-shaped.

That is fragile for two reasons:

1. different providers have different credential lifecycles
2. even within one provider, different auth modes behave very differently

The current Anthropic OAuth path is the clearest example:

- ClawDad can read a current Claude Code access token from `~/.claude/.credentials.json`
- but ClawDad does not perform its own refresh-token exchange
- so after a long idle period, the service can forward an expired bearer token and fail with `401`
- some other Claude action may refresh the credential store later, which makes the system look flaky instead of deterministic

This gets more important as ClawDad adds:

- Anthropic API keys
- Anthropic Max / Claude Code OAuth
- OpenAI API keys
- GitHub Copilot / GitHub Models auth
- Ollama local/no-auth execution
- LiteLLM / OpenRouter / proxy-backed providers

## Design Principle

**Credential lifecycle belongs to the provider integration, not to the orchestrator.**

ClawDad core should not need to know:

- whether a provider uses API keys, OAuth, helper scripts, or local trust
- whether tokens expire
- whether refresh is proactive or on-demand
- whether health means "configured" or "actually usable"

ClawDad core should only ask:

- what auth mode is active?
- is this runtime currently usable?
- can you produce auth material for this request?
- what category of auth failure occurred?

## Why the current Anthropic path is insufficient

Today the credential proxy does this:

- re-read `.env` and Claude Code credentials on every request
- prefer API key if present
- otherwise read the current Claude access token
- forward that token as `Authorization: Bearer ...`

That is useful, but it is not true refresh behavior.

It assumes one of these is already true:

- the access token is still fresh
- Claude Code has already refreshed the credential store out of band

That assumption is weak for a long-running idle service.

## Desired Architecture

Introduce a provider auth boundary parallel to the runtime boundary.

### Core concepts

```typescript
type ProviderAuthStatus =
  | 'ready'
  | 'needs_login'
  | 'refreshing'
  | 'expired'
  | 'misconfigured'
  | 'unsupported';

type ProviderAuthFailureCategory =
  | 'auth'
  | 'expired'
  | 'permission'
  | 'provider_unavailable'
  | 'transport'
  | 'unknown';

interface ProviderAuthMaterial {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  expiresAt?: number;
  source: 'env' | 'helper' | 'oauth-store' | 'local-runtime' | 'none';
}

interface ProviderAuthHealth {
  status: ProviderAuthStatus;
  provider: string;
  authMode?: string;
  expiresAt?: number;
  refreshable: boolean;
  lastValidatedAt?: string;
  notes: string[];
}

interface ProviderAuthAdapter {
  provider: string;

  getHealth(config: AgentRuntimeConfig): Promise<ProviderAuthHealth>;
  getAuthMaterial(config: AgentRuntimeConfig): Promise<ProviderAuthMaterial>;

  onAuthFailure?(
    config: AgentRuntimeConfig,
    error: unknown,
  ): Promise<ProviderAuthHealth | void>;
}
```

## Provider-specific expectations

### Anthropic

Must support multiple auth modes:

- static API key
- Claude Code OAuth / Max-style login
- helper-based dynamic auth in the future

Important distinction:

- API key mode is relatively stable
- Claude Code OAuth is expiring and should be treated as refreshable/volatile

The Anthropic adapter should eventually support one of these stronger paths:

1. helper-based dynamic auth
2. explicit refresh-token exchange if Anthropic exposes a supported path for this workflow
3. an adapter-managed "reauth required" state that is surfaced clearly and recoverably

For now, the adapter should at minimum:

- report whether auth is only "configured" or actually "fresh enough"
- classify `401` as an auth lifecycle failure, not a generic model failure
- avoid making `/api/health` look green when auth is stale

### OpenAI

Usually API-key-based and more static.

The adapter can be simpler:

- read key
- provide header
- validate presence
- report auth health

Still should live behind the same interface.

### Ollama

Typically local and unauthenticated.

The auth adapter should simply report:

- `ready`
- `refreshable: false`
- source `local-runtime`

This is important because "no auth needed" is still an auth posture that the rest of the system should understand.

### GitHub Copilot / GitHub Models

Likely closer to an OAuth/session-backed world than a static-key world.

That means Copilot is another reason not to bake "env key = auth solved" into ClawDad core.

The provider adapter should own:

- how tokens are discovered
- whether they expire
- whether they are refreshable
- whether the current user/session is authorized for the selected model

## Health model changes

Today health is mostly:

- Docker running
- credentials configured
- image built

That is not enough for expiring-provider auth.

We should move toward:

```typescript
interface ProviderHealthSummary {
  configured: boolean;
  usable: boolean;
  refreshable: boolean;
  status: 'ready' | 'stale' | 'needs_login' | 'misconfigured';
  authMode?: string;
  notes: string[];
}
```

For Anthropic OAuth specifically, this lets the UI distinguish:

- configured but stale
- configured and ready
- missing login

## Request-time behavior

Provider auth should be acquired at request time, not frozen globally at startup.

That does not mean every provider must hit the network on every request.
It means the adapter owns the refresh/cache policy.

Examples:

- API key: can cache forever
- helper-based token: cache for helper TTL
- OAuth access token: cache until near expiry, then refresh or re-read
- Ollama: no auth material needed

## Failure handling

When a request fails with auth semantics:

- the provider adapter should get the first chance to interpret or recover
- the failure should normalize to a stable category
- the UI should surface an actionable state

Example:

- Anthropic bearer token returns `401`
- adapter marks auth as `stale` or `needs_login`
- health reflects that immediately
- future runs fail fast with a clearer reason until revalidated

This is better than "chat request failed with 401, but health still says ready."

## Recommended implementation order

### Phase 1: Honest auth status

- add provider auth health types
- teach health/UI to distinguish `configured` from `usable`
- classify Anthropic OAuth staleness explicitly

### Phase 2: Provider auth adapters

- add `ProviderAuthAdapter` interface
- move Anthropic credential resolution behind it
- add trivial adapters for OpenAI and Ollama

### Phase 3: Runtime integration

- runtime adapter asks provider auth adapter for request-time auth material
- auth failures normalize through the provider auth layer

### Phase 4: Refresh-capable Anthropic flow

- preferred: helper-based/dynamic auth path compatible with Claude Code expectations
- fallback: explicit stale detection + reauth workflow if true refresh is not available

## Recommendation

Yes: token management should become part of the provider integration.

More precisely:

- credential lifecycle belongs to the provider auth adapter
- request encoding/execution belongs to the runtime adapter
- ClawDad core owns only normalized health, failure categories, and capability-aware UX

That keeps Anthropic Max/OAuth from distorting the rest of the system, while still leaving room for:

- persistent API-key providers
- local no-auth runtimes
- future OAuth/session-based providers like Copilot

## Open Questions

1. Should provider auth live inside the runtime adapter or adjacent to it?
My recommendation: adjacent but closely paired. Runtime asks auth for request material.

2. Should `/api/health` validate provider auth live?
Probably not for every request. Better to report cached/provider-known auth state plus a last-validated timestamp.

3. Should ClawDad own refresh-token exchange directly for Anthropic?
Only if Anthropic supports that workflow cleanly and durably. Otherwise helper-based auth is safer than reverse-engineering private refresh behavior.
