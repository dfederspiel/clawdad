import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetOllamaCapabilitiesForTests,
  fetchOllamaCapabilities,
  getOllamaCapabilities,
  refreshOllamaCapabilities,
} from './ollama-capabilities.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetOllamaCapabilitiesForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body: unknown },
): void {
  globalThis.fetch = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const { status, body } = handler(String(url), init);
      return new Response(JSON.stringify(body), { status });
    },
  ) as unknown as typeof fetch;
}

describe('ollama-capabilities', () => {
  it('fetchOllamaCapabilities parses /api/show and caches the result', async () => {
    mockFetch(() => ({
      status: 200,
      body: { capabilities: ['completion', 'tools'] },
    }));

    const caps = await fetchOllamaCapabilities('llama3.2:1b');
    expect(caps).toEqual({ tools: true, vision: false, thinking: false });
    expect(getOllamaCapabilities('llama3.2:1b')).toEqual(caps);
  });

  it('reflects all three capability flags from /api/show', async () => {
    mockFetch(() => ({
      status: 200,
      body: { capabilities: ['completion', 'tools', 'vision', 'thinking'] },
    }));
    const caps = await fetchOllamaCapabilities('qwen3.5:4b');
    expect(caps).toEqual({ tools: true, vision: true, thinking: true });
  });

  it('returns undefined on HTTP error without polluting the cache', async () => {
    mockFetch(() => ({ status: 404, body: {} }));
    const caps = await fetchOllamaCapabilities('nonexistent:latest');
    expect(caps).toBeUndefined();
    expect(getOllamaCapabilities('nonexistent:latest')).toBeUndefined();
  });

  it('returns undefined on transport failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const caps = await fetchOllamaCapabilities('llama3.2:1b');
    expect(caps).toBeUndefined();
  });

  it('refreshOllamaCapabilities warms every model listed by /api/tags', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return {
          status: 200,
          body: {
            models: [{ name: 'llama3.2:1b' }, { name: 'qwen3.5:4b' }],
          },
        };
      }
      if (url.endsWith('/api/show')) {
        return {
          status: 200,
          body: { capabilities: ['completion', 'tools'] },
        };
      }
      return { status: 500, body: {} };
    });

    await refreshOllamaCapabilities();
    expect(getOllamaCapabilities('llama3.2:1b')).toEqual({
      tools: true,
      vision: false,
      thinking: false,
    });
    expect(getOllamaCapabilities('qwen3.5:4b')).toEqual({
      tools: true,
      vision: false,
      thinking: false,
    });
  });

  it('refreshOllamaCapabilities is a no-op when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(refreshOllamaCapabilities()).resolves.toBeUndefined();
    expect(getOllamaCapabilities('llama3.2:1b')).toBeUndefined();
  });

  it('refreshOllamaCapabilities coalesces concurrent refreshes into one in-flight promise', async () => {
    let tagsCalls = 0;
    mockFetch((url) => {
      if (url.endsWith('/api/tags')) {
        tagsCalls += 1;
        return { status: 200, body: { models: [] } };
      }
      return { status: 500, body: {} };
    });
    await Promise.all([
      refreshOllamaCapabilities(),
      refreshOllamaCapabilities(),
    ]);
    expect(tagsCalls).toBe(1);
  });
});
