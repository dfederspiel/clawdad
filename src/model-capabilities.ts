/**
 * Static capability matrix per (provider, model).
 *
 * Today this is a curated table — there is no probing yet. The goal is to
 * have one place in code that answers "what can this runtime actually do
 * for us today?" so context injection, UI warnings, and runtime governance
 * can all consult the same source of truth.
 *
 * Important distinction: this reports *effective* capabilities given the
 * orchestrator plumbing we have today, not the model's theoretical maximum.
 * Ollama models that advertise `tools: true` via `/api/show` still return
 * `receivesMcpTools: false` here because the Ollama runtime adapter does
 * not currently pass a `tools` array to `/api/chat`. Wiring that up is
 * Phase 4b of #69 — until then, telling an Ollama agent about MCP tools
 * is misinformation regardless of what model it runs.
 */

import type { AgentRuntimeConfig } from './runtime-types.js';

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
}

const ANTHROPIC_PROFILE: CapabilityProfile = {
  receivesMcpTools: true,
  streaming: 'chunked',
};

// Ollama: adapter currently doesn't pass a tools array, so no MCP tools
// reach any Ollama model. Streaming is per-token; the host buffers.
const OLLAMA_PROFILE: CapabilityProfile = {
  receivesMcpTools: false,
  streaming: 'per-token',
};

// Safe default for providers we haven't wired yet. Assume text-only so
// platform context doesn't lie about tools that aren't plumbed.
const UNSUPPORTED_PROFILE: CapabilityProfile = {
  receivesMcpTools: false,
  streaming: 'whole',
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
  if (provider === 'ollama') return OLLAMA_PROFILE;
  return UNSUPPORTED_PROFILE;
}
