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
 * `receivesMcpTools: false` here unless we've validated the full loop
 * end-to-end — nominal ≠ reliable. The allowlist in
 * TOOL_CAPABLE_OLLAMA_MODELS mirrors the one in the container's
 * `ollama-runtime.ts` (single source of truth lives on the host; the
 * container allowlist is a belt-and-suspenders guard against misconfig).
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

// Ollama models for which the container adapter wires tools end-to-end.
// Starts narrow: qwen3.5:4b is our baseline that we've verified calls
// `mcp__nanoclaw__send_message` reliably. Models with `tools: true` in
// Ollama's /api/show but too small to use them reliably (llama3.2:1b,
// llama3.2:3b) stay off this list — they produce narration-of-tool-calls
// instead of real invocations. Widen as models are validated.
const TOOL_CAPABLE_OLLAMA_MODELS = new Set<string>(['qwen3.5:4b']);

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
    if (model && TOOL_CAPABLE_OLLAMA_MODELS.has(model)) {
      return OLLAMA_TOOL_CAPABLE_PROFILE;
    }
    return OLLAMA_TEXT_ONLY_PROFILE;
  }
  return UNSUPPORTED_PROFILE;
}
