/**
 * Ollama capability cache — host-side discovery of per-model capabilities
 * via `/api/show`, so getCapabilityProfile() can stay synchronous while
 * still reflecting what Ollama actually reports instead of a hand-curated
 * allowlist.
 *
 * Why a cache rather than an inline async fetch: getCapabilityProfile is
 * called in many places on the hot path (runtime resolution, agent
 * discovery, multi-agent context, API responses). Converting every one
 * to async would cascade widely for a field that rarely changes. Instead
 * we warm the cache at startup (best-effort) and re-refresh on demand.
 *
 * Treatment of misses: a model that isn't in the cache returns
 * `undefined`, which callers interpret as "assume text-only". This is
 * the safe default — it matches the previous hardcoded behaviour for
 * any model that wasn't on the allowlist. Meanwhile a background refresh
 * kicks off so the next call lands in the cache.
 */

import { logger } from './logger.js';

export interface OllamaCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

interface OllamaShowResponse {
  capabilities?: string[];
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

const cache = new Map<string, OllamaCapabilities>();
let refreshInFlight: Promise<void> | null = null;

function ollamaHost(): string {
  return process.env.OLLAMA_HOST || 'http://localhost:11434';
}

function fromShow(res: OllamaShowResponse): OllamaCapabilities {
  const caps = new Set(res.capabilities ?? []);
  return {
    tools: caps.has('tools'),
    vision: caps.has('vision'),
    thinking: caps.has('thinking'),
  };
}

export async function fetchOllamaCapabilities(
  model: string,
  host: string = ollamaHost(),
): Promise<OllamaCapabilities | undefined> {
  try {
    const res = await fetch(`${host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as OllamaShowResponse;
    const caps = fromShow(body);
    cache.set(model, caps);
    return caps;
  } catch {
    return undefined;
  }
}

/**
 * Warm the cache by listing installed models and querying each.
 * Best-effort: swallows errors so startup doesn't block when Ollama is
 * absent or unreachable.
 */
export async function refreshOllamaCapabilities(
  host: string = ollamaHost(),
): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${host}/api/tags`);
      if (!res.ok) return;
      const body = (await res.json()) as OllamaTagsResponse;
      const models = (body.models ?? []).map((m) => m.name);
      await Promise.all(
        models.map(async (name) => {
          await fetchOllamaCapabilities(name, host);
        }),
      );
      logger.info(
        { count: cache.size, host },
        'Ollama capability cache refreshed',
      );
    } catch (err) {
      logger.debug(
        { err, host },
        'Ollama capability refresh failed (service may be unavailable)',
      );
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Synchronous read. Returns undefined on miss — callers should treat
 * that as "not tool-capable" and may schedule a background refresh.
 */
export function getOllamaCapabilities(
  model: string,
): OllamaCapabilities | undefined {
  return cache.get(model);
}

/**
 * Background refresh for use on cache misses — fire-and-forget.
 * Idempotent: coalesces via refreshInFlight.
 */
export function scheduleOllamaCapabilityRefresh(host?: string): void {
  void refreshOllamaCapabilities(host).catch(() => {});
}

// Test-only helper.
export function _resetOllamaCapabilitiesForTests(): void {
  cache.clear();
  refreshInFlight = null;
}

// Test-only helper: inject a known capability into the cache.
export function _setOllamaCapabilitiesForTests(
  model: string,
  caps: OllamaCapabilities,
): void {
  cache.set(model, caps);
}
