import { describe, it, expect, afterEach } from 'vitest';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ToolBridge } from './tool-bridge.js';

// --- test harness ---------------------------------------------------------

async function spawnInProcessServer(
  name: string,
  register: (server: McpServer) => void,
) {
  const server = new McpServer({ name, version: 'test' });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

async function makeBridge(
  pairs: Array<{ name: string; register: (server: McpServer) => void }>,
) {
  const preConnected = [] as Array<{
    name: string;
    transport: InMemoryTransport;
  }>;
  for (const p of pairs) {
    const { clientTransport } = await spawnInProcessServer(p.name, p.register);
    preConnected.push({ name: p.name, transport: clientTransport });
  }
  const bridge = new ToolBridge({ preConnected });
  await bridge.connect();
  return bridge;
}

let bridges: ToolBridge[] = [];

afterEach(async () => {
  for (const b of bridges) await b.close();
  bridges = [];
});

function track(b: ToolBridge): ToolBridge {
  bridges.push(b);
  return b;
}

// --- tests ----------------------------------------------------------------

describe('ToolBridge.listTools', () => {
  it('returns tools from every connected server with qualified names', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) =>
            s.tool('hello', 'say hi', {}, async () => ({
              content: [{ type: 'text' as const, text: 'hi' }],
            })),
        },
        {
          name: 'beta',
          register: (s) =>
            s.tool('echo', 'echo input', { text: z.string() }, async (args) => ({
              content: [{ type: 'text' as const, text: args.text }],
            })),
        },
      ]),
    );

    const tools = await bridge.listTools();
    const names = tools.map((t) => t.qualifiedName).sort();
    expect(names).toEqual(['mcp__alpha__hello', 'mcp__beta__echo']);
    const echo = tools.find((t) => t.qualifiedName === 'mcp__beta__echo');
    expect(echo?.description).toBe('echo input');
    expect(echo?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('filters disallowed qualified names', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) => {
            s.tool('keep', 'kept', {}, async () => ({
              content: [{ type: 'text' as const, text: 'ok' }],
            }));
            s.tool('drop', 'dropped', {}, async () => ({
              content: [{ type: 'text' as const, text: 'ok' }],
            }));
          },
        },
      ]),
    );
    const tools = await bridge.listTools(['mcp__alpha__drop']);
    expect(tools.map((t) => t.qualifiedName)).toEqual(['mcp__alpha__keep']);
  });

  it('throws if called before connect()', async () => {
    const bridge = new ToolBridge({ preConnected: [] });
    await expect(bridge.listTools()).rejects.toThrow(/connect\(\)/);
  });
});

describe('ToolBridge.toProviderSpecs', () => {
  it('flattens descriptors to name/description/parameters triplets', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) =>
            s.tool('greet', 'greet someone', { who: z.string() }, async () => ({
              content: [{ type: 'text' as const, text: 'hi' }],
            })),
        },
      ]),
    );
    const tools = await bridge.listTools();
    const specs = bridge.toProviderSpecs(tools);
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('mcp__alpha__greet');
    expect(specs[0].description).toBe('greet someone');
    expect(specs[0].parameters).toMatchObject({ type: 'object' });
  });
});

describe('ToolBridge.executeToolCall', () => {
  it('routes the call to the right server and returns text content', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) =>
            s.tool('echo', 'echo', { text: z.string() }, async (args) => ({
              content: [{ type: 'text' as const, text: `alpha:${args.text}` }],
            })),
        },
        {
          name: 'beta',
          register: (s) =>
            s.tool('echo', 'echo', { text: z.string() }, async (args) => ({
              content: [{ type: 'text' as const, text: `beta:${args.text}` }],
            })),
        },
      ]),
    );

    const a = await bridge.executeToolCall('mcp__alpha__echo', { text: 'hi' });
    const b = await bridge.executeToolCall('mcp__beta__echo', { text: 'hi' });
    expect(a.isError).toBe(false);
    expect(a.content).toBe('alpha:hi');
    expect(b.content).toBe('beta:hi');
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a structured error for unqualified names', async () => {
    const bridge = track(await makeBridge([]));
    const r = await bridge.executeToolCall('not_qualified', {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unknown tool name/);
  });

  it('returns a structured error when the server is not connected', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) =>
            s.tool('x', 'x', {}, async () => ({
              content: [{ type: 'text' as const, text: 'ok' }],
            })),
        },
      ]),
    );
    const r = await bridge.executeToolCall('mcp__missing__x', {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/No MCP server named "missing"/);
  });

  it('surfaces tool-side isError back to the caller', async () => {
    const bridge = track(
      await makeBridge([
        {
          name: 'alpha',
          register: (s) =>
            s.tool('boom', 'fails', {}, async () => ({
              content: [{ type: 'text' as const, text: 'something went wrong' }],
              isError: true,
            })),
        },
      ]),
    );
    const r = await bridge.executeToolCall('mcp__alpha__boom', {});
    expect(r.isError).toBe(true);
    expect(r.content).toBe('something went wrong');
  });
});
