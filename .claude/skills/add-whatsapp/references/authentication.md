## Phase 3: Authentication

### Clean previous auth state (if re-authenticating)

```bash
rm -rf store/auth/
```

### Run WhatsApp authentication

For QR code in browser (recommended):

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

(Bash timeout: 150000ms)

Tell the user:

> A browser window will open with a QR code.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code in the browser
> 3. The page will show "Authenticated!" when done

For QR code in terminal:

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal
```

Tell the user to run `npm run auth` in another terminal, then:

> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code displayed in the terminal

For pairing code:

Tell the user to have WhatsApp open on **Settings > Linked Devices > Link a Device**, ready to tap **"Link with phone number instead"** — the code expires in ~60 seconds and must be entered immediately.

Run the auth process in the background and poll `store/pairing-code.txt` for the code:

```bash
rm -f store/pairing-code.txt && npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <their-phone-number> > /tmp/wa-auth.log 2>&1 &
```

Then immediately poll for the code (do NOT wait for the background command to finish):

```bash
for i in $(seq 1 20); do [ -f store/pairing-code.txt ] && cat store/pairing-code.txt && break; sleep 1; done
```

Display the code to the user the moment it appears. Tell them:

> **Enter this code now** — it expires in ~60 seconds.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Tap **Link with phone number instead**
> 3. Enter the code immediately

After the user enters the code, poll for authentication to complete:

```bash
for i in $(seq 1 60); do grep -q 'AUTH_STATUS: authenticated' /tmp/wa-auth.log 2>/dev/null && echo "authenticated" && break; grep -q 'AUTH_STATUS: failed' /tmp/wa-auth.log 2>/dev/null && echo "failed" && break; sleep 2; done
```

**If failed:** qr_timeout → re-run. logged_out → delete `store/auth/` and re-run. 515 → re-run. timeout → ask user, offer retry.

### Verify authentication succeeded

```bash
test -f store/auth/creds.json && echo "Authentication successful" || echo "Authentication failed"
```

### Configure environment

Channels auto-enable when their credentials are present — WhatsApp activates when `store/auth/creds.json` exists.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```
