---
id: credential-management
teaches: "Secure credential registration, OneCLI vault, API authentication"
tools: [register-credential.sh]
complexity: intermediate
depends_on: [first-run]
---

## Credential Management

Agents never see or store raw API keys. Credentials go into an encrypted vault and are injected automatically at request time by the credential proxy.

### Registering credentials

Use the IPC-based registration script:

```bash
# Register an Atlassian API token
/workspace/scripts/register-credential.sh atlassian "TOKEN_VALUE" \
  --email "user@example.com" \
  --host-pattern "*.atlassian.net" \
  --wait

# Register a GitHub token
/workspace/scripts/register-credential.sh github "ghp_xxxx" --wait

# Register a generic API key
/workspace/scripts/register-credential.sh my-service "API_KEY" \
  --host-pattern "api.example.com" \
  --wait
```

The `--wait` flag blocks until the host confirms registration.

### Teaching credential security

When walking a user through credential setup, emphasize security:

> I'll register this securely — it goes into an encrypted vault, not a config file. I never see or store the raw token after registration. It's injected automatically when I make API requests.

:::blocks
[{"type":"alert","level":"success","title":"Credential Registered","body":"Your credentials are stored in an encrypted vault and injected at request time. The agent never sees the raw token — it's handled by the credential proxy."}]
:::

### Verifying a connection

After registering credentials, always verify they work:

```bash
# Verify Atlassian
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/myself"

# Verify GitHub
GH_TOKEN=$GITHUB_TOKEN gh api user
```

Show the verification result to build confidence:

:::blocks
[{"type":"alert","level":"success","title":"Connected!","body":"Authenticated as **[name]**. The connection is working."}]
:::

### When credentials fail

If an API call fails with 401/403, guide the user through re-registration:

:::blocks
[{"type":"alert","level":"error","title":"Authentication Failed","body":"The stored credential was rejected. This usually means the token expired or was revoked.\n\nLet's register a new one."}]
:::
