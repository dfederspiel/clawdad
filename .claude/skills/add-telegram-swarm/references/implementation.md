## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add the bot pool config near the other Telegram exports:

```typescript
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
```

### Step 2: Add Bot Pool to Telegram Module

Read `src/telegram.ts` and add the following:

1. **Update imports** — add `Api` to the Grammy import:

```typescript
import { Api, Bot } from 'grammy';
```

2. **Add pool state** after the existing `let bot` declaration:

```typescript
// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
```

3. **Add pool functions** — place these before the `isTelegramConnected` function:

```typescript
/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot
    await sendTelegramMessage(chatId, text);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
```

### Step 3: Add sender Parameter to MCP Tool

Read `container/agent-runner/src/ipc-mcp-stdio.ts` and update the `send_message` tool to accept an optional `sender` parameter:

Change the tool's schema from:
```typescript
{ text: z.string().describe('The message text to send') },
```

To:
```typescript
{
  text: z.string().describe('The message text to send'),
  sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
},
```

And update the handler to include `sender` in the IPC data:

```typescript
async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
```

### Step 4: Update Host IPC Routing

Read `src/ipc.ts` and make these changes:

1. **Add imports** — add `sendPoolMessage` and `initBotPool` from the Telegram swarm module, and `TELEGRAM_BOT_POOL` from config.

2. **Update IPC message routing** — in `src/ipc.ts`, find where the `sendMessage` dependency is called to deliver IPC messages (inside `processIpcFiles`). The `sendMessage` is passed in via the `IpcDeps` parameter. Wrap it to route Telegram swarm messages through the bot pool:

```typescript
if (data.sender && data.chatJid.startsWith('tg:')) {
  await sendPoolMessage(
    data.chatJid,
    data.text,
    data.sender,
    sourceGroup,
  );
} else {
  await deps.sendMessage(data.chatJid, data.text);
}
```

Note: The assistant name prefix is handled by `formatOutbound()` in the router — Telegram channels have `prefixAssistantName = false` so no prefix is added for `tg:` JIDs.

3. **Initialize pool in `main()` in `src/index.ts`** — after creating the Telegram channel, add:

```typescript
if (TELEGRAM_BOT_POOL.length > 0) {
  await initBotPool(TELEGRAM_BOT_POOL);
}
```

### Step 5: Update CLAUDE.md Files

#### 5a. Add global message formatting rules

Read `groups/global/CLAUDE.md` and add a Message Formatting section:

```markdown
## Message Formatting

NEVER use markdown. Only use WhatsApp/Telegram formatting:
- *single asterisks* for bold (NEVER **double asterisks**)
- _underscores_ for italic
- • bullet points
- ```triple backticks``` for code

No ## headings. No [links](url). No **double stars**.
```

#### 5b. Update existing group CLAUDE.md headings

In any group CLAUDE.md that has a "WhatsApp Formatting" section (e.g. `groups/main/CLAUDE.md`), rename the heading to reflect multi-channel support:

```
## WhatsApp Formatting (and other messaging apps)
```

#### 5c. Add Agent Teams instructions to Telegram groups

For each Telegram group that will use agent teams, create or update its `groups/{folder}/CLAUDE.md` with these instructions. Read the existing CLAUDE.md first (or `groups/global/CLAUDE.md` as a base) and add the Agent Teams section:

```markdown
## Agent Teams

When creating a team to tackle a complex task, follow these rules:

### CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1". If the user says "a marine biologist, a physicist, and Alexander Hamilton", create exactly those three agents with those exact names.

### Team member instructions

Each team member MUST be instructed to:

1. *Share progress in the group* via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name (e.g., `sender: "Marine Biologist"` or `sender: "Alexander Hamilton"`). This makes their messages appear from a dedicated bot in the Telegram group.
2. *Also communicate with teammates* via `SendMessage` as normal for coordination.
3. Keep group messages *short* — 2-4 sentences max per message. Break longer content into multiple `send_message` calls. No walls of text.
4. Use the `sender` parameter consistently — always the same name so the bot identity stays stable.
5. NEVER use markdown formatting. Use ONLY WhatsApp/Telegram formatting: single *asterisks* for bold (NOT **double**), _underscores_ for italic, • for bullets, ```backticks``` for code. No ## headings, no [links](url), no **double asterisks**.

### Example team creation prompt

When creating a teammate, include instructions like:

\```
You are the Marine Biologist. When you have findings or updates for the user, send them to the group using mcp__nanoclaw__send_message with sender set to "Marine Biologist". Keep each message short (2-4 sentences max). Use emojis for strong reactions. ONLY use single *asterisks* for bold (never **double**), _underscores_ for italic, • for bullets. No markdown. Also communicate with teammates via SendMessage.
\```

### Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those directly from the teammate bots.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your *entire* output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.
```

### Step 6: Update Environment

Add pool tokens to `.env`:

```bash
TELEGRAM_BOT_POOL=TOKEN1,TOKEN2,TOKEN3,...
```

**Important**: Sync to all required locations:

```bash
cp .env data/env/env
```

Also add `TELEGRAM_BOT_POOL` to the launchd plist (`~/Library/LaunchAgents/com.nanoclaw.plist`) in the `EnvironmentVariables` dict if using launchd.

### Step 7: Rebuild and Restart

```bash
npm run build
./container/build.sh  # Required — MCP tool changed
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user restart nanoclaw
```

Must use `unload/load` (macOS) or `restart` (Linux) because the service env vars changed.

### Step 8: Test

Tell the user:

> Send a message in your Telegram group asking for a multi-agent task, e.g.:
> "Assemble a team of a researcher and a coder to build me a hello world app"
>
> You should see:
> - The lead agent (main bot) acknowledging and creating the team
> - Each subagent messaging from a different bot, renamed to their role
> - Short, scannable messages from each agent
>
> Check logs: `tail -f logs/nanoclaw.log | grep -i pool`
