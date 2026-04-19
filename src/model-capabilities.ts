/**
 * Capability matrix per (provider, model).
 *
 * For Ollama this is derived from the live `/api/show capabilities` list
 * via the cache in ollama-capabilities.ts — warmed at startup so reads
 * here stay synchronous. For Anthropic the profile is static because the
 * SDK owns the tool loop and we already rely on it across models.
 *
 * Design note (was: "nominal ≠ reliable"). The previous iteration of
 * this file kept a hand-curated `TOOL_CAPABLE_OLLAMA_MODELS` set because
 * we were worried small models would narrate tool calls rather than
 * invoke them. Empirical probe (scripts/probe-ollama-tools.ts) showed
 * the opposite: both llama3.2:1b and qwen3.5:4b return structured
 * `tool_calls` when given a schema — the small model just has weaker
 * argument adherence, which is a reliability concern, not a capability
 * gap. We now treat Ollama's self-report as the source of truth and
 * let observability (cost/turns per run) surface bad outcomes.
 */

import type { AgentRuntimeConfig } from './runtime-types.js';
import {
  getOllamaCapabilities,
  scheduleOllamaCapabilityRefresh,
} from './ollama-capabilities.js';

export interface CapabilityProfile {
  /**
   * True iff the runtime adapter actually passes MCP tools to the model.
   * Drives whether platform-injected context should mention MCP tool
   * invocations. If false, the agent responds in plain text and the host
   * delivers that text as the user-visible message.
   */
  receivesMcpTools: boolean;

  /**
   * Shape of streamed content emitted to the host. `per-token` means the
   * host must buffer before emitting a chat message (otherwise you get one
   * DB row per token). `chunked` is paragraph-sized pieces. `whole` means
   * only a final full message, no streaming.
   */
  streaming: 'per-token' | 'chunked' | 'whole';

  /**
   * Max time the host waits for a delegated turn to complete before
   * cancelling and surfacing a "specialist was unable to complete" error.
   * Picked off the **specialist's** profile at delegation time: fast
   * cloud APIs (Claude) fail fast so a wedged container doesn't stall
   * the group; slow local models (CPU-only Ollama) get headroom for
   * real tool-loop work (observed 83s–467s on qwen3.5:4b, macOS CPU).
   */
  delegationTimeoutMs: number;
}

const ANTHROPIC_PROFILE: CapabilityProfile = {
  receivesMcpTools: true,
  streaming: 'chunked',
  delegationTimeoutMs: 120_000, // 2 min — fast cloud API, fail fast on hangs
};

// Ollama streaming is always per-token on the wire (the host buffers in
// the runtime adapter).
const OLLAMA_TEXT_ONLY_PROFILE: CapabilityProfile = {
  receivesMcpTools: false,
  streaming: 'per-token',
  delegationTimeoutMs: 300_000, // 5 min — CPU-only text generation, no tool loop
};

const OLLAMA_TOOL_CAPABLE_PROFILE: CapabilityProfile = {
  receivesMcpTools: true,
  // Tool loop runs non-streaming turns (we need the full response to read
  // tool_calls); the final assistant message is delivered whole.
  streaming: 'whole',
  delegationTimeoutMs: 600_000, // 10 min — headroom for CPU-only tool loops
};

// Safe default for providers we haven't wired yet. Assume text-only so
// platform context doesn't lie about tools that aren't plumbed.
const UNSUPPORTED_PROFILE: CapabilityProfile = {
  receivesMcpTools: false,
  streaming: 'whole',
  delegationTimeoutMs: 120_000, // 2 min — conservative default until wired
};

/**
 * Look up the capability profile for a runtime config. When runtime is
 * undefined or uses a provider the orchestrator treats as Claude-native
 * (the platform default), returns the Anthropic profile.
 */
export function getCapabilityProfile(
  runtime: AgentRuntimeConfig | undefined,
): CapabilityProfile {
  const provider = runtime?.provider;
  if (!provider || provider === 'anthropic') return ANTHROPIC_PROFILE;
  if (provider === 'ollama') {
    const model = runtime?.model;
    if (!model) return OLLAMA_TEXT_ONLY_PROFILE;
    const caps = getOllamaCapabilities(model);
    if (caps === undefined) {
      // Cache miss — schedule a background refresh so the next call has
      // accurate data, and return the safe default for this one.
      scheduleOllamaCapabilityRefresh();
      return OLLAMA_TEXT_ONLY_PROFILE;
    }
    return caps.tools ? OLLAMA_TOOL_CAPABLE_PROFILE : OLLAMA_TEXT_ONLY_PROFILE;
  }
  return UNSUPPORTED_PROFILE;
}
