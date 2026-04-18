/**
 * Shared ollama-js client factory.
 *
 * Preserves the host.docker.internal -> localhost fallback that our
 * previous hand-rolled ollama-fetch had: the default host inside the
 * container is host.docker.internal (which reaches the host on Docker
 * Desktop / Apple Container), and we fall back to localhost if that
 * address isn't reachable (e.g. Linux with --network=host).
 */
import { Ollama } from 'ollama';

export const DEFAULT_OLLAMA_HOST = 'http://host.docker.internal:11434';

const configuredHost = process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;

/**
 * A fetch wrapper that retries against localhost if a host.docker.internal
 * request fails for a connection-level reason. We only substitute the host
 * portion — path and init are preserved exactly.
 */
const fallbackFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input as RequestInfo, init);
  } catch (err) {
    if (typeof input === 'string' && input.includes('host.docker.internal')) {
      const retry = input.replace('host.docker.internal', 'localhost');
      return await fetch(retry, init);
    }
    if (input instanceof Request && input.url.includes('host.docker.internal')) {
      const retryUrl = input.url.replace('host.docker.internal', 'localhost');
      return await fetch(retryUrl, init);
    }
    throw err;
  }
};

/** Lazy singleton — ollama-js clients are cheap but there's no need for multiples. */
let cached: Ollama | null = null;

export function getOllamaClient(): Ollama {
  if (!cached) {
    cached = new Ollama({ host: configuredHost, fetch: fallbackFetch });
  }
  return cached;
}
