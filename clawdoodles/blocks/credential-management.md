---
id: credential-management
teaches: "Secure credential registration via browser popup, .env credential proxy"
tools: [request_credential]
complexity: intermediate
depends_on: [first-run]
---

## Credential Management

Agents never see or store raw API keys. Credentials go into an encrypted vault and are injected automatically at request time by the credential proxy.

**CRITICAL: Never ask users to paste secrets in chat.** Use the `request_credential` MCP tool instead — it opens a secure popup in the browser.

### Requesting credentials

Use the `request_credential` MCP tool to trigger a secure browser popup:

```
Use request_credential with:
- service: "atlassian" (or "github", "gitlab", "launchdarkly", or custom name)
- host_pattern: "*.atlassian.net" (optional — uses service default if omitted)
- description: "Why this credential is needed — shown to the user"
- email: "user@example.com" (required for Atlassian Basic auth)
```

The tool:
1. Opens a popup in the user's browser with pre-filled metadata
2. User enters their secret in the form (you never see it)
3. Secret goes directly to the encrypted vault
4. Tool returns success/failure — then you can make API calls

### Teaching credential security

When walking a user through credential setup, explain the flow:

> I'll open a secure form for you to enter your API token. I never see the secret — it goes straight into an encrypted vault and is injected automatically when I make API requests.

### Verifying a connection

After the credential is registered, verify it works:

```bash
# Verify Atlassian
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/myself"

# Verify GitHub
GH_TOKEN=$GITHUB_TOKEN gh api user
```

Show the verification result:

:::blocks
[{"type":"alert","level":"success","title":"Connected!","body":"Authenticated as **[name]**. The connection is working."}]
:::

### When credentials fail

If an API call fails with 401/403, guide the user to re-register:

> The stored credential was rejected — it may have expired. I'll open the form again so you can enter a new one.

Then call `request_credential` again.

### CLI fallback

For advanced cases or if the popup doesn't work:

> If you prefer, you can add credentials directly to `.env` — variables matching `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD` are automatically forwarded to containers.
