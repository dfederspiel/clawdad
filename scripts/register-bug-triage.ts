#!/usr/bin/env npx tsx
/**
 * One-shot script to register the bug_triage group and its scheduled task.
 *
 * Usage: npx tsx scripts/register-bug-triage.ts [DISCORD_CHANNEL_ID]
 *
 * If no channel ID is provided, defaults to the #bug-triage channel.
 */

import { initDatabase, setRegisteredGroup, createTask, getTaskById, getRegisteredGroup, deleteTask } from '../src/db.js';

const CHANNEL_ID = process.argv[2] || '1486501882540326952';
const JID = `dc:${CHANNEL_ID}`;
const GROUP_FOLDER = 'bug_triage';

initDatabase();

// --- Register (or update) the group ---
const groupConfig = {
  name: 'Bug Triage',
  folder: GROUP_FOLDER,
  trigger: '@bug',
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      { hostPath: '~/code/polaris-ui', containerPath: 'polaris-ui', readonly: true },
      { hostPath: '~/code/polaris-react-composition', containerPath: 'polaris-react-composition', readonly: true },
    ],
    timeout: 600000, // 10 minutes
  },
  requiresTrigger: false,
  isMain: false,
};

const existing = getRegisteredGroup(JID);
setRegisteredGroup(JID, existing ? { ...existing, ...groupConfig } : groupConfig);
console.log(`${existing ? 'Updated' : 'Registered'} group "${GROUP_FOLDER}" — trigger=@bug, requiresTrigger=false`);

// --- Create (or recreate) the scheduled task ---
const TASK_ID = 'task-bug-triage-poll';
const existingTask = getTaskById(TASK_ID);
if (existingTask) {
  deleteTask(TASK_ID);
  console.log(`Deleted existing task "${TASK_ID}" to recreate with updated prompt.`);
}

const alertPrompt = `Poll Jira for bug tickets in POLUIG and alert the channel. Follow your CLAUDE.md instructions.

Run the three queries in priority order (fresh bugs first, then backlog, then stalled).
Check /workspace/group/triage-state.json for previously seen keys as secondary dedup.

For each bug found (max 3 total per run, prioritizing Query 1 results):
1. Alert the channel using the format in your CLAUDE.md (red/yellow/white by urgency)
2. Assess scope → pick an action tier (auto-fix / auto-triage / escalate)
3. For Tier 1-2: search the codebases, analyze, post Jira comment
4. For Tier 3: summarize in chat, suggest assignee
5. Add "triage-analyzed" label to the ticket
6. Update /workspace/group/triage-state.json

If no untriaged bugs across all queries, say "No new bugs to report." and stop.
If more than 3, process the 3 highest-priority and note remaining count.`;

createTask({
  id: TASK_ID,
  group_folder: GROUP_FOLDER,
  chat_jid: JID,
  prompt: alertPrompt,
  schedule_type: 'cron',
  schedule_value: '7 * * * *',  // every hour at :07
  context_mode: 'isolated',
  next_run: new Date().toISOString(),
  status: 'active',
  created_at: new Date().toISOString(),
});
console.log(`Created scheduled task "${TASK_ID}" (hourly cron at :07)`);

console.log('\nDone. Restart NanoClaw to pick up the new group.');
