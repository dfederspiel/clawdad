---
name: add-whatsapp
description: Add WhatsApp as a channel. Can replace other channels entirely or run alongside them. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

This skill adds WhatsApp support to NanoClaw. It installs the WhatsApp channel code, dependencies, and guides through authentication, registration, and configuration.

## Phase 1: Pre-flight

### Check current state

Check if WhatsApp is already configured. If `store/auth/` exists with credential files, skip to Phase 4 (Registration) or Phase 5 (Verify).

```bash
ls store/auth/creds.json 2>/dev/null && echo "WhatsApp auth exists" || echo "No WhatsApp auth"
```

### Detect environment

Check whether the environment is headless (no display server):

```bash
[[ -z "$DISPLAY" && -z "$WAYLAND_DISPLAY" && "$OSTYPE" != darwin* ]] && echo "IS_HEADLESS=true" || echo "IS_HEADLESS=false"
```

### Ask the user

Use `AskUserQuestion` to collect configuration. **Adapt auth options based on environment:**

If IS_HEADLESS=true AND not WSL → AskUserQuestion: How do you want to authenticate WhatsApp?
- **Pairing code** (Recommended) - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: How do you want to authenticate WhatsApp?
- **QR code in browser** (Recommended) - Opens a browser window with a large, scannable QR code
- **Pairing code** - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

If they chose pairing code:

AskUserQuestion: What is your phone number? (Digits only — country code followed by your 10-digit number, no + prefix, spaces, or dashes. Example: 14155551234 where 1 is the US country code and 4155551234 is the phone number.)

## Phase 2: Apply Code Changes

Check if `src/channels/whatsapp.ts` already exists. If it does, skip to Phase 3 (Authentication).

### Ensure channel remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp main
git merge whatsapp/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/whatsapp.ts` (WhatsAppChannel class with self-registration via `registerChannel`)
- `src/channels/whatsapp.test.ts` (41 unit tests)
- `src/whatsapp-auth.ts` (standalone WhatsApp authentication script)
- `setup/whatsapp-auth.ts` (WhatsApp auth setup step)
- `import './whatsapp.js'` appended to the channel barrel file `src/channels/index.ts`
- `'whatsapp-auth'` step added to `setup/index.ts`
- `@whiskeysockets/baileys`, `qrcode`, `qrcode-terminal` npm dependencies in `package.json`
- `ASSISTANT_HAS_OWN_NUMBER` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Authentication

Read `${CLAUDE_SKILL_DIR}/references/authentication.md` for the full auth flow (QR browser, QR terminal, pairing code with polling, failure handling, verify, and environment configuration).

## Phase 4: Registration

Read `${CLAUDE_SKILL_DIR}/references/registration.md` for trigger/channel type configuration, JID discovery for each chat type, and register commands.

## Phase 5: Verify, Troubleshooting, and Removal

Read `${CLAUDE_SKILL_DIR}/references/troubleshooting.md` for build/restart, connection testing, and troubleshooting (QR expired, pairing code, conflict disconnection, bot not responding, group names, after setup, removal).
