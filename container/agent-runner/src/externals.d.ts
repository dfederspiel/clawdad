// Type stubs for packages installed at container build time (not available locally).
// These mirror the subset of exports used by agent-runner. The full types ship
// with @anthropic-ai/claude-agent-sdk >= 0.2.112.
//
// Intentionally uses `any` for return types and some parameters to avoid
// breaking existing code that accesses SDK message properties dynamically.
declare module '@anthropic-ai/claude-agent-sdk' {
  export function query(options: any): any;

  export type HookCallback = (
    input: any,
    toolUseId: string | undefined,
    context: { signal: AbortSignal },
  ) => Promise<any>;

  export interface PreCompactHookInput {
    hook_event_name: 'PreCompact';
    trigger: 'manual' | 'auto';
    custom_instructions: string | null;
    transcript_path?: string;
    session_id?: string;
    [key: string]: any;
  }
}

declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export class McpServer {
    constructor(options: { name: string; version: string });
    tool(name: string, description: string, schema: any, handler: (args: any) => Promise<any>): void;
    connect(transport: any): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {}
}
