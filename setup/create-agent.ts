/**
 * CLI script to create a new agent (web group) via the running service's API.
 *
 * Usage:
 *   npx tsx setup/create-agent.ts --name "Jokester" --folder jokester \
 *     [--template code-review] [--schedule "0 9 * * 1-5"] [--prompt "Tell a joke"]
 *
 * This calls POST /api/groups on the running web UI server, which handles:
 *   - In-memory registration (no restart needed)
 *   - SQLite persistence
 *   - Group folder + CLAUDE.md creation
 *   - Template file copying (if --template provided)
 *   - Global user-config merge into agent-config.json
 *   - OneCLI agent provisioning
 *
 * If --schedule is provided, also creates a scheduled task via POST /api/tasks.
 */

import { WEB_UI_PORT } from '../src/config.ts';

interface CreateAgentArgs {
  name: string;
  folder: string;
  template?: string;
  schedule?: string; // cron expression
  prompt?: string; // prompt for scheduled task
  contextMode?: string; // 'isolated' or 'group'
}

function parseArgs(args: string[]): CreateAgentArgs {
  const result: CreateAgentArgs = { name: '', folder: '' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--template':
        result.template = args[++i] || undefined;
        break;
      case '--schedule':
        result.schedule = args[++i] || undefined;
        break;
      case '--prompt':
        result.prompt = args[++i] || undefined;
        break;
      case '--context-mode':
        result.contextMode = args[++i] || undefined;
        break;
    }
  }

  return result;
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `http://localhost:${WEB_UI_PORT}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name || !args.folder) {
    console.error('Usage: npx tsx setup/create-agent.ts --name "Name" --folder folder_name');
    console.error('  [--template template_id] [--schedule "cron expr"] [--prompt "task prompt"]');
    process.exit(1);
  }

  if (args.schedule && !args.prompt) {
    console.error('Error: --prompt is required when --schedule is provided');
    process.exit(1);
  }

  // Step 1: Create the group via the running service API
  console.log(`Creating agent "${args.name}" (folder: ${args.folder})...`);

  let groupResult: { ok: boolean; status: number; data: Record<string, unknown> };
  try {
    groupResult = await apiPost('/api/groups', {
      name: args.name,
      folder: args.folder,
      template: args.template,
    });
  } catch (err) {
    console.error(
      'Error: Could not reach the NanoClaw service.',
      `Is it running on port ${WEB_UI_PORT}?`,
    );
    console.error('Start it with: npm run dev');
    process.exit(2);
  }

  if (!groupResult.ok) {
    console.error(`Error creating group: ${JSON.stringify(groupResult.data)}`);
    process.exit(3);
  }

  const jid = groupResult.data.jid as string;
  const group = groupResult.data.group as Record<string, unknown>;
  console.log(`Agent created: ${jid} (folder: ${group.folder})`);

  // Step 2: Create scheduled task if requested
  if (args.schedule && args.prompt) {
    console.log(`Creating scheduled task: "${args.prompt}" [${args.schedule}]`);

    const taskResult = await apiPost('/api/tasks', {
      group_folder: group.folder,
      chat_jid: jid,
      prompt: args.prompt,
      schedule_type: 'cron',
      schedule_value: args.schedule,
      context_mode: args.contextMode || 'isolated',
    });

    if (!taskResult.ok) {
      console.error(`Warning: Failed to create task: ${JSON.stringify(taskResult.data)}`);
    } else {
      const task = taskResult.data.task as Record<string, unknown>;
      console.log(`Task created: ${task.id} (next run: ${task.next_run || 'computing...'})`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
