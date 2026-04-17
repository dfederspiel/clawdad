/**
 * Shared Ollama HTTP fetch utility.
 * Used by both the Ollama MCP tool and the Ollama runtime adapter.
 */

export const DEFAULT_OLLAMA_HOST = 'http://host.docker.internal:11434';

const ollamaHost =
  process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;

export async function ollamaFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${ollamaHost}${path}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (ollamaHost.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}
