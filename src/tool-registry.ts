/**
 * Registry of tools the platform can expose to an agent. Read by the
 * web UI to render the per-agent tool picker (#74 Phase 2b) and by any
 * host-side validation that wants to confirm an agent.tools entry is
 * a real tool rather than a typo.
 *
 * Two sources:
 *  - Claude SDK tools — the built-in file/search/web/task toolset the
 *    SDK ships. Kept in sync with the default allowlist in
 *    container/agent-runner/src/claude-runtime.ts.
 *  - Nanoclaw MCP tools — the IPC tools the orchestrator registers for
 *    the agent. Kept in sync with container/agent-runner/src/ipc-mcp-stdio.ts.
 *
 * The duplication is deliberate: the runtime lives in a separate tsconfig
 * (container/agent-runner) and cannot import host modules at build time.
 * Changes to either list should be mirrored here.
 */

export interface ToolDescriptor {
  /** Canonical tool name. SDK tools are bare (e.g. "WebSearch"); MCP tools are prefixed (e.g. "mcp__nanoclaw__send_message"). */
  name: string;
  /** Short human-readable label for UI (falls back to name). */
  label: string;
  /** One-line description for UI tooltips. */
  description: string;
  /** Grouping for the UI: where this tool comes from. */
  source: 'claude-sdk' | 'mcp-nanoclaw';
  /** Whether the tool is a safe default — UI can pre-check these for new agents. */
  defaultForRole?: 'coordinator' | 'specialist';
}

export const CLAUDE_SDK_TOOLS: ToolDescriptor[] = [
  {
    name: 'Bash',
    label: 'Bash',
    description: 'Run shell commands in the container.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Read',
    label: 'Read',
    description: 'Read files from disk.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Write',
    label: 'Write',
    description: 'Write files to disk.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Edit',
    label: 'Edit',
    description: 'Edit files by exact string replacement.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Glob',
    label: 'Glob',
    description: 'Find files by glob pattern.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Grep',
    label: 'Grep',
    description: 'Search file contents with ripgrep.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'WebSearch',
    label: 'Web Search',
    description: 'Search the web.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'WebFetch',
    label: 'Web Fetch',
    description: 'Fetch and read a URL.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Task',
    label: 'Task',
    description: 'Spawn a subagent for a focused task.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'TaskOutput',
    label: 'Task Output',
    description: 'Read output from a running subagent.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'TaskStop',
    label: 'Task Stop',
    description: 'Stop a running subagent.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'TeamCreate',
    label: 'Team Create',
    description: 'Create a multi-agent team.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'TeamDelete',
    label: 'Team Delete',
    description: 'Delete a team.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'SendMessage',
    label: 'Send Message',
    description: 'Send a message to a channel (SDK-native).',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'TodoWrite',
    label: 'Todo Write',
    description: 'Manage the session todo list.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'ToolSearch',
    label: 'Tool Search',
    description: 'Discover deferred tool schemas.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'Skill',
    label: 'Skill',
    description: 'Invoke a Claude Code skill.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
  {
    name: 'NotebookEdit',
    label: 'Notebook Edit',
    description: 'Edit a Jupyter notebook cell.',
    source: 'claude-sdk',
    defaultForRole: 'coordinator',
  },
];

export const NANOCLAW_MCP_TOOLS: ToolDescriptor[] = [
  {
    name: 'mcp__nanoclaw__send_message',
    label: 'Send Message',
    description: 'Send a message to the user or group while still running.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'specialist',
  },
  {
    name: 'mcp__nanoclaw__publish_media',
    label: 'Publish Media',
    description: 'Publish an image into the web chat thread.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__publish_browser_snapshot',
    label: 'Publish Browser Snapshot',
    description: 'Capture and publish the current browser view.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__escalate',
    label: 'Escalate',
    description: 'Send a message to the main group.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__schedule_task',
    label: 'Schedule Task',
    description: 'Schedule a recurring or one-time task.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__list_tasks',
    label: 'List Tasks',
    description: 'List scheduled tasks.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__pause_task',
    label: 'Pause Task',
    description: 'Pause a scheduled task.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__resume_task',
    label: 'Resume Task',
    description: 'Resume a paused task.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__cancel_task',
    label: 'Cancel Task',
    description: 'Cancel and delete a scheduled task.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__update_task',
    label: 'Update Task',
    description: 'Update an existing scheduled task.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__register_group',
    label: 'Register Group',
    description: 'Register a new agent group (main only).',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__register_team',
    label: 'Register Team',
    description: 'Create a multi-agent team (main only).',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__unlock_achievement',
    label: 'Unlock Achievement',
    description: 'Unlock a first-time user achievement.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__request_credential',
    label: 'Request Credential',
    description: 'Prompt the user to register a credential.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__play_sound',
    label: 'Play Sound',
    description: "Play a notification sound in the user's UI.",
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__set_subtitle',
    label: 'Set Subtitle',
    description: 'Set a status line under the group name.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
  {
    name: 'mcp__nanoclaw__set_agent_status',
    label: 'Set Agent Status',
    description: 'Set a status line for the agent row.',
    source: 'mcp-nanoclaw',
    defaultForRole: 'specialist',
  },
  {
    name: 'mcp__nanoclaw__delegate_to_agent',
    label: 'Delegate To Agent',
    description: 'Delegate a task to another agent (coordinators only).',
    source: 'mcp-nanoclaw',
    defaultForRole: 'coordinator',
  },
];

export function listAvailableTools(): ToolDescriptor[] {
  return [...CLAUDE_SDK_TOOLS, ...NANOCLAW_MCP_TOOLS];
}
