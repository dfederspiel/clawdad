## Troubleshooting

### Authentication Expired

```bash
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Browser Lock Files

If Chrome fails to launch:

```bash
rm -f data/x-browser-profile/SingletonLock
rm -f data/x-browser-profile/SingletonSocket
rm -f data/x-browser-profile/SingletonCookie
```

### Check Logs

```bash
# Host logs (relative to project root)
grep -i "x_post\|x_like\|x_reply\|handleXIpc" logs/nanoclaw.log | tail -20

# Script errors
grep -i "error\|failed" logs/nanoclaw.log | tail -20
```

### Script Timeout

Default timeout is 2 minutes (120s). Increase in `host.ts`:

```typescript
const timer = setTimeout(() => {
  proc.kill('SIGTERM');
  resolve({ success: false, message: 'Script timed out (120s)' });
}, 120000);  // <- Increase this value
```

### X UI Selector Changes

If X updates their UI, selectors in scripts may break. Current selectors:

| Element | Selector |
|---------|----------|
| Tweet input | `[data-testid="tweetTextarea_0"]` |
| Post button | `[data-testid="tweetButtonInline"]` |
| Reply button | `[data-testid="reply"]` |
| Like | `[data-testid="like"]` |
| Unlike | `[data-testid="unlike"]` |
| Retweet | `[data-testid="retweet"]` |
| Unretweet | `[data-testid="unretweet"]` |
| Confirm retweet | `[data-testid="retweetConfirm"]` |
| Modal dialog | `[role="dialog"][aria-modal="true"]` |
| Modal submit | `[data-testid="tweetButton"]` |

### Container Build Issues

If MCP tools not found in container:

```bash
# Verify build copies skill
./container/build.sh 2>&1 | grep -i skill

# Check container has the file
docker run nanoclaw-agent ls -la /app/src/skills/
```

## Security

- `data/x-browser-profile/` - Contains X session cookies (in `.gitignore`)
- `data/x-auth.json` - Auth state marker (in `.gitignore`)
- Only main group can use X tools (enforced in `agent.ts` and `host.ts`)
- Scripts run as subprocesses with limited environment
