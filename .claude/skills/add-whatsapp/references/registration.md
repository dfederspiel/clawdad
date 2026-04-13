## Phase 4: Registration

### Configure trigger and channel type

Get the bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Is this a shared phone number (personal WhatsApp) or a dedicated number (separate device)?
- **Shared number** - Your personal WhatsApp number (recommended: use self-chat or a solo group)
- **Dedicated number** - A separate phone/SIM for the assistant

AskUserQuestion: What trigger word should activate the assistant?
- **@Andy** - Default trigger
- **@Claw** - Short and easy
- **@Claude** - Match the AI name

AskUserQuestion: What should the assistant call itself?
- **Andy** - Default name
- **Claw** - Short and easy
- **Claude** - Match the AI name

AskUserQuestion: Where do you want to chat with the assistant?

**Shared number options:**
- **Self-chat** (Recommended) - Chat in your own "Message Yourself" conversation
- **Solo group** - A group with just you and the linked device
- **Existing group** - An existing WhatsApp group

**Dedicated number options:**
- **DM with bot** (Recommended) - Direct message the bot's number
- **Solo group** - A group with just you and the bot
- **Existing group** - An existing WhatsApp group

### Get the JID

**Self-chat:** JID = your phone number with `@s.whatsapp.net`. Extract from auth credentials:

```bash
node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0]+'@s.whatsapp.net')"
```

**DM with bot:** Ask for the bot's phone number. JID = `NUMBER@s.whatsapp.net`

**Group (solo, existing):** Run group sync and list available groups:

```bash
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step groups --list
```

The output shows `JID|GroupName` pairs. Present candidates as AskUserQuestion (names only, not JIDs).

### Register the chat

```bash
npx tsx setup/index.ts --step register \
  --jid "<jid>" \
  --name "<chat-name>" \
  --trigger "@<trigger>" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "<name>" \
  --is-main \
  --no-trigger-required  # Only for main/self-chat
```

For additional groups (trigger-required):

```bash
npx tsx setup/index.ts --step register \
  --jid "<group-jid>" \
  --name "<group-name>" \
  --trigger "@<trigger>" \
  --folder "whatsapp_<group-name>" \
  --channel whatsapp
```
