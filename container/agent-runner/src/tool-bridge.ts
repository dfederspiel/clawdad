/**
 * ToolBridge — a provider-neutral surface for MCP tools inside the agent
 * container.
 *
 * Claude's runtime doesn't need this because the Agent SDK owns the entire
 * tool loop internally — schema discovery, invocation, result feedback.
 * For any other runtime (Ollama today; OpenAI / openrouter / litellm in
 * future) we have to run the loop ourselves. The bridge is the shared
 * machinery those adapters use:
 *
 *   1. Spawn one MCP stdio server per config (or connect to any Transport).
 *   2. List their tools and normalise to a provider-neutral shape.
 *   3. Execute a tool call by qualified name, returning the result text.
 *   4. Close cleanly on shutdown.
 *
 * Deliberately NOT in this module (to keep the contract tight):
 *   - The agentic loop itself. Each adapter drives its own loop.
 *   - Provider-specific tool formats. Adapters translate from the neutral
 *     `ProviderToolSpec` to whatever their API expects (Ollama uses a near-
 *     JSON-Schema format; so does OpenAI; both are trivial adapters).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface McpServerConfig {
  /** Logical server name. Used as the prefix in qualified tool names. */
  name: string;
  /** Binary to spawn (e.g. "node"). */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpToolDescriptor {
  serverName: string;
  /** The server-local tool name, e.g. "send_message". */
  name: string;
  /** Stable `mcp__<server>__<tool>` form, used across provider APIs. */
  qualifiedName: string;
  description: string;
  /** JSON Schema for the tool's arguments, as returned by the MCP server. */
  inputSchema: Record<string, unknown>;
}

export interface ProviderToolSpec {
  /** Qualified name; adapters translate this to their provider's format. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResult {
  /** Text the model sees on its next turn. */
  content: string;
  isError: boolean;
  durationMs: number;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: Transport;
}

const CLIENT_VERSION = '1.0.0';

function buildQualifiedName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function parseQualifiedName(
  qualified: string,
): { serverName: string; toolName: string } | null {
  const match = qualified.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}

export class ToolBridge {
  private servers: ConnectedServer[] = [];
  private connected = false;

  /**
   * Construct a bridge. Pass either a set of MCP server configs (for
   * production — bridge spawns the subprocesses itself) or a ready-made
   * Transport (for tests — InMemoryTransport linked to a test server).
   */
  constructor(
    private readonly options:
      | { servers: McpServerConfig[] }
      | { preConnected: Array<{ name: string; transport: Transport }> },
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if ('preConnected' in this.options) {
      for (const entry of this.options.preConnected) {
        const client = new Client({
          name: `clawdad-tool-bridge-${entry.name}`,
          version: CLIENT_VERSION,
        });
        await client.connect(entry.transport);
        this.servers.push({
          name: entry.name,
          client,
          transport: entry.transport,
        });
      }
    } else {
      for (const cfg of this.options.servers) {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        });
        const client = new Client({
          name: `clawdad-tool-bridge-${cfg.name}`,
          version: CLIENT_VERSION,
        });
        await client.connect(transport);
        this.servers.push({ name: cfg.name, client, transport });
      }
    }
    this.connected = true;
  }

  /**
   * List every tool reachable through every connected server. Optionally
   * filter out disallowed qualified names (matches the existing
   * RuntimeTurnConstraints.disallowedTools shape).
   */
  async listTools(disallowed?: string[]): Promise<McpToolDescriptor[]> {
    if (!this.connected) {
      throw new Error('ToolBridge: connect() must be called before listTools()');
    }
    const disallowSet = disallowed ? new Set(disallowed) : null;
    const results: McpToolDescriptor[] = [];
    for (const server of this.servers) {
      const { tools } = await server.client.listTools();
      for (const t of tools) {
        const qualifiedName = buildQualifiedName(server.name, t.name);
        if (disallowSet?.has(qualifiedName)) continue;
        results.push({
          serverName: server.name,
          name: t.name,
          qualifiedName,
          description: t.description || '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
          },
        });
      }
    }
    return results;
  }

  /** Neutral shape ready for per-provider translation (Ollama / OpenAI / …). */
  toProviderSpecs(tools: McpToolDescriptor[]): ProviderToolSpec[] {
    return tools.map((t) => ({
      name: t.qualifiedName,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  /**
   * Invoke a tool by its qualified `mcp__<server>__<tool>` name.
   * Unknown tools, execution errors, and transport errors all return
   * {isError: true} with a human-readable message — the adapter is expected
   * to feed this back to the model as a tool result so it can recover.
   */
  async executeToolCall(
    qualifiedName: string,
    args: unknown,
  ): Promise<ToolExecutionResult> {
    if (!this.connected) {
      throw new Error(
        'ToolBridge: connect() must be called before executeToolCall()',
      );
    }
    const started = Date.now();
    const parsed = parseQualifiedName(qualifiedName);
    if (!parsed) {
      return {
        content: `Unknown tool name "${qualifiedName}" (expected mcp__<server>__<tool>).`,
        isError: true,
        durationMs: Date.now() - started,
      };
    }
    const server = this.servers.find((s) => s.name === parsed.serverName);
    if (!server) {
      return {
        content: `No MCP server named "${parsed.serverName}" is connected.`,
        isError: true,
        durationMs: Date.now() - started,
      };
    }
    try {
      const result = await server.client.callTool({
        name: parsed.toolName,
        arguments: (args && typeof args === 'object'
          ? (args as Record<string, unknown>)
          : {}) as Record<string, unknown>,
      });
      const content = extractTextContent(result);
      const isError = Boolean((result as { isError?: boolean }).isError);
      return {
        content,
        isError,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        content: `Tool call to ${qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        durationMs: Date.now() - started,
      };
    }
  }

  async close(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close();
      } catch {
        /* best-effort */
      }
    }
    this.servers = [];
    this.connected = false;
  }
}

/**
 * MCP tool results can be structured content (text / image / resource).
 * For the tool-call-result → model-feedback path we only care about text;
 * non-text parts are summarised so the model sees *something*.
 */
function extractTextContent(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as { type?: string }).type;
    if (type === 'text') {
      parts.push(String((part as { text?: unknown }).text ?? ''));
    } else if (type === 'image') {
      parts.push('[image content]');
    } else if (type === 'resource') {
      parts.push('[resource content]');
    } else {
      parts.push(`[${type ?? 'unknown'} content]`);
    }
  }
  return parts.join('\n');
}
