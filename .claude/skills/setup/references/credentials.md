## 4. Credential System

All credentials are stored in `.env` and injected by the built-in credential proxy. The proxy auto-detects the auth mode based on which variable is set.

AskUserQuestion: How do you connect to Claude?

1. **Claude subscription (Pro/Max)** -- description: "Uses your existing Claude Pro or Max subscription via setup-token."
2. **Direct Anthropic API** -- description: "Pay-per-use API key from console.anthropic.com."
3. **LiteLLM proxy** -- description: "Your team runs a LiteLLM proxy that routes to Anthropic. You'll need the proxy URL and an API key."

### Subscription path (OAuth token)

Tell the user:

> Run `claude setup-token` in another terminal and complete the authentication flow.

Then stop and wait for the user to confirm they've completed it. Do NOT proceed until they respond.

Once confirmed, copy the token from Claude Code's credential store and save to `.env`:

```bash
# Extract token from Claude Code credentials
TOKEN=$(python -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d['claudeAiOauth']['accessToken'])")
# On Windows with Git Bash, use the Windows-style home path if needed:
# TOKEN=$(python -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/.credentials.json'))); print(d['claudeAiOauth']['accessToken'])")

# Save as ANTHROPIC_AUTH_TOKEN (NOT ANTHROPIC_API_KEY -- OAuth tokens require Bearer auth)
grep -q 'ANTHROPIC_AUTH_TOKEN' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_AUTH_TOKEN.*|ANTHROPIC_AUTH_TOKEN=$TOKEN|" .env || \
  echo "ANTHROPIC_AUTH_TOKEN=$TOKEN" >> .env
```

**Important:** OAuth tokens (`sk-ant-oat01-...`) must use `ANTHROPIC_AUTH_TOKEN`. Setting them as `ANTHROPIC_API_KEY` will fail with "Invalid API key" because the proxy sends them as `x-api-key` instead of `Authorization: Bearer`.

### Direct API path

Tell user to get a key from https://console.anthropic.com/settings/keys if they don't have one.

**If the user pastes a key starting with `sk-ant-api03-`:** save it directly to `.env`.

```bash
grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_API_KEY.*|ANTHROPIC_API_KEY=<KEY>|" .env || \
  echo "ANTHROPIC_API_KEY=<KEY>" >> .env
```

Make sure `ANTHROPIC_BASE_URL` is NOT set (or commented out) in `.env` for direct API.

### LiteLLM proxy path

AskUserQuestion: "What's your LiteLLM proxy URL?" with placeholder `https://your-litellm-proxy.example.com`.

Then ask: "What API key should I use for the proxy?" (They can paste it directly -- handle gracefully.)

Set both in `.env`:
```bash
grep -q 'ANTHROPIC_BASE_URL' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_BASE_URL.*|ANTHROPIC_BASE_URL=<proxy-url>|" .env || \
  echo "ANTHROPIC_BASE_URL=<proxy-url>" >> .env

grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null && \
  sed -i "s|.*ANTHROPIC_API_KEY.*|ANTHROPIC_API_KEY=<KEY>|" .env || \
  echo "ANTHROPIC_API_KEY=<KEY>" >> .env
```

### After any path

Verify credentials are configured:
```bash
grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' .env
```

If neither is found, ask the user to try again.
