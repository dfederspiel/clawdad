## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                       │
│  └── agent.ts → MCP tool definitions (x_post, etc.)    │
│      └── Writes IPC request to /workspace/ipc/tasks/       │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (file system)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Host (macOS)                                               │
│  └── src/ipc.ts → processTaskIpc()                         │
│      └── host.ts → handleXIpc()                         │
│          └── spawn subprocess → scripts/*.ts               │
│              └── Playwright → Chrome → X Website           │
└─────────────────────────────────────────────────────────────┘
```

### Why This Design?

- **API is expensive** - X official API requires paid subscription ($100+/month) for posting
- **Bot browsers get blocked** - X detects and bans headless browsers and common automation fingerprints
- **Must use user's real browser** - Reuses the user's actual Chrome on Host with real browser fingerprint to avoid detection
- **One-time authorization** - User logs in manually once, session persists in Chrome profile for future use

### File Structure

```
.claude/skills/x-integration/
├── SKILL.md          # This documentation
├── host.ts           # Host-side IPC handler
├── agent.ts          # Container-side MCP tool definitions
├── lib/
│   ├── config.ts     # Centralized configuration
│   └── browser.ts    # Playwright utilities
└── scripts/
    ├── setup.ts      # Interactive login
    ├── post.ts       # Post tweet
    ├── like.ts       # Like tweet
    ├── reply.ts      # Reply to tweet
    ├── retweet.ts    # Retweet
    └── quote.ts      # Quote tweet
```
