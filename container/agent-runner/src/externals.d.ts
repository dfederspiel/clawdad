// Type stubs for packages installed at container build time (not available locally)
declare module '@anthropic-ai/claude-agent-sdk' {
  export function query(options: any): any;
  export type HookCallback = (input: any, toolUseId: any, context: any) => Promise<any>;
  export interface PreCompactHookInput {
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
