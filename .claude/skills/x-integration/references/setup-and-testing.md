## Detailed Setup

All paths below are relative to project root (`NANOCLAW_ROOT`).

### 1. Check Chrome Path

```bash
# Check if Chrome exists at configured path
cat .env | grep CHROME_PATH
ls -la "$(grep CHROME_PATH .env | cut -d= -f2)" 2>/dev/null || \
echo "Chrome not found - update CHROME_PATH in .env"
```

### 2. Run Authentication

```bash
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
```

This opens Chrome for manual X login. Session saved to `data/x-browser-profile/`.

**Verify success:**
```bash
cat data/x-auth.json  # Should show {"authenticated": true, ...}
```

### 3. Rebuild Container

```bash
./container/build.sh
```

**Verify success:**
```bash
./container/build.sh 2>&1 | grep -i "agent.ts"  # Should show COPY line
```

### 4. Restart Service

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

**Verify success:**
```bash
launchctl list | grep nanoclaw  # macOS — should show PID and exit code 0 or -
# Linux: systemctl --user status nanoclaw
```

## Testing

Scripts require environment variables from `.env`. Use `dotenv-cli` to load them:

### Check Authentication Status

```bash
# Check if auth file exists and is valid
cat data/x-auth.json 2>/dev/null && echo "Auth configured" || echo "Auth not configured"

# Check if browser profile exists
ls -la data/x-browser-profile/ 2>/dev/null | head -5
```

### Re-authenticate (if expired)

```bash
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
```

### Test Post (will actually post)

```bash
echo '{"content":"Test tweet - please ignore"}' | npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/post.ts
```

### Test Like

```bash
echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/like.ts
```

Or export `CHROME_PATH` manually before running:

```bash
export CHROME_PATH="/path/to/chrome"
echo '{"content":"Test"}' | npx tsx .claude/skills/x-integration/scripts/post.ts
```
