## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild -- channel merges may introduce new packages:

Build the agent container:
```bash
./container/build.sh
```

If it fails:
- Cache issue: `docker builder prune -f` then retry
- Missing files: diagnose from output and fix

Verify:
```bash
docker images nanoclaw-agent:latest --format '{{.ID}}'
```

## 5b. Environment Check

Run `npx tsx setup/index.ts --step environment` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped -> `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found -> re-run step 7
- CREDENTIALS=missing -> re-run step 4 (check `.env` for `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`)
- CHANNEL_AUTH shows `not_found` for any channel -> re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 -> re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing -> `npx tsx setup/index.ts --step mounts -- --empty`

### Web UI & Port Selection

Ensure `.env` has web UI enabled:
```bash
grep -q 'WEB_UI_ENABLED=true' .env || echo 'WEB_UI_ENABLED=true' >> .env
```

**Always check for other running ClawDad/NanoClaw instances before assigning a port.** Scan the default port range to detect existing instances and pick the next free port:

```bash
# Find all nanoclaw processes and their ports
OTHER_PORTS=$(lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep node | grep -oE ':(345[0-9]|346[0-9])' | tr -d ':' | sort -u)
echo "Ports in use by other instances: ${OTHER_PORTS:-none}"

# Check candidate ports starting at 3456
for PORT in 3456 3457 3458 3459 3460; do
  lsof -i :$PORT >/dev/null 2>&1 || { echo "FREE_PORT=$PORT"; break; }
done
```

- **If 3456 is free and no other instances detected:** Use 3456 (the default). Set in `.env`:
  ```bash
  grep -q 'WEB_UI_PORT' .env || echo 'WEB_UI_PORT=3456' >> .env
  ```

- **If other instances are detected:** Tell the user what you found, e.g. "I found another ClawDad instance running on port 3456." Then AskUserQuestion: "I'll use port <FREE_PORT> for this instance. Sound good?"
  - **Yes (recommended)** -- description: "Use port <FREE_PORT>. You'll access this instance at http://localhost:<FREE_PORT>."
  - **Different port** -- description: "Choose a custom port number."

  Update `.env` with the chosen port:
  ```bash
  grep -q 'WEB_UI_PORT' .env && sed -i '' "s/WEB_UI_PORT=.*/WEB_UI_PORT=<PORT>/" .env || echo "WEB_UI_PORT=<PORT>" >> .env
  ```

Tell the user their web UI URL so they know which instance is which: "This instance will run at http://localhost:<PORT>".

## 6. Start

AskUserQuestion: How do you want to run ClawDad?

1. **Background service (recommended)** -- description: "Registers as a system service that starts on boot. Best for always-on operation."
2. **Development mode** -- description: "Runs in the foreground with hot reload. Best for making code changes."

### Background service

Run `npx tsx setup/index.ts --step service` and parse status block.

- macOS: uses launchd (`~/Library/LaunchAgents/com.nanoclaw.plist`)
- Linux: uses systemd (`~/.config/systemd/user/nanoclaw.service`)

Handle errors per the diagnostics in the service step output.

Tell user: "ClawDad is running as a background service. Open http://localhost:PORT in your browser."

### Development mode

```bash
npm run build && npm run start
```

Tell user: "ClawDad is running. Open http://localhost:PORT in your browser."

## 7. Verify

Open the health check endpoint to confirm everything is green:

```bash
curl -s http://localhost:3456/api/health | python3 -m json.tool
```

Check that:
- `docker.status` = "running"
- `credential_proxy.status` = "configured"
- `anthropic.status` = "configured"
- `container_image.status` = "built"
- `overall` = "ready"

If anything is not green, go back to the relevant step and fix it.

Tell the user:

> Setup complete! Open http://localhost:3456 to access the web UI.
>
> From here you can:
> - **Create agents** from templates (deployments, updates, bug triage)
> - **Chat with agents** directly in the browser
> - **Review scheduled tasks** and their execution history
>
> To add more complex agents or customize behavior, run `claude` and describe what you want.

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing credentials in `.env` (re-run step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails:** Ensure Docker is running. Check container logs in `groups/*/logs/container-*.log`.

**"Invalid API key" errors:** If using an OAuth token (`sk-ant-oat01-`), it must be set as `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. If using a custom endpoint, ensure `ANTHROPIC_BASE_URL` in `.env` is correct.

**Web UI won't load:** Ensure `WEB_UI_ENABLED=true` in `.env`. Check port conflicts: `lsof -i :3456`.
