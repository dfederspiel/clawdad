## Phase 5: Verify

### Build and restart

```bash
npm run build
```

Restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw

# Linux (nohup fallback)
bash start-nanoclaw.sh
```

### Test the connection

Tell the user:

> Send a message to your registered WhatsApp chat:
> - For self-chat / main: Any message works
> - For groups: Use the trigger word (e.g., "@Andy hello")
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### QR code expired

QR codes expire after ~60 seconds. Re-run the auth command:

```bash
rm -rf store/auth/ && npx tsx src/whatsapp-auth.ts
```

### Pairing code not working

Codes expire in ~60 seconds. To retry:

```bash
rm -rf store/auth/ && npx tsx src/whatsapp-auth.ts --pairing-code --phone <phone>
```

Enter the code **immediately** when it appears. Also ensure:
1. Phone number is digits only — country code + number, no `+` prefix (e.g., `14155551234` where `1` is country code, `4155551234` is the number)
2. Phone has internet access
3. WhatsApp is updated to the latest version

If pairing code keeps failing, switch to QR-browser auth instead:

```bash
rm -rf store/auth/ && npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

### "conflict" disconnection

This happens when two instances connect with the same credentials. Ensure only one NanoClaw process is running:

```bash
pkill -f "node dist/index.js"
# Then restart
```

### Bot not responding

Check:
1. Auth credentials exist: `ls store/auth/creds.json`
3. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE '%whatsapp%' OR jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. Logs: `tail -50 logs/nanoclaw.log`

### Group names not showing

Run group metadata sync:

```bash
npx tsx setup/index.ts --step groups
```

This fetches all group names from WhatsApp. Runs automatically every 24 hours.

## After Setup

If running `npm run dev` while the service is active:

```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove WhatsApp integration:

1. Delete auth credentials: `rm -rf store/auth/`
2. Remove WhatsApp registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
3. Sync env: `mkdir -p data/env && cp .env data/env/env`
4. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
