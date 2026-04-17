# Credential Management

ClawDad uses a **built-in credential proxy** to manage API credentials. The proxy reads secrets from `.env` and injects them into outbound requests from agent containers. Agents never see raw API keys or tokens.

## How It Works

```
Agent Container  --->  Credential Proxy (localhost)  --->  External API
                       (substitutes placeholders with
                        real values from .env)
```

1. You store secrets in `.env` (API keys, OAuth tokens)
2. The credential proxy starts alongside ClawDad
3. Containers get **placeholder values** instead of real credentials (e.g. `GITHUB_TOKEN=__CRED_GITHUB_TOKEN__`)
4. Agents use `api.sh` which routes requests through the proxy's `/forward` endpoint
5. The proxy re-reads `.env` on every request, substitutes `__CRED_*__` placeholders with real values, and forwards to the upstream API
6. New credentials are available immediately after registration — no container restart needed

**Two proxy paths:**
- **Anthropic** (default path) — reverse proxy for Claude API, injects Anthropic credentials
- **`/forward`** (generic path) — forward proxy for any service, does placeholder string substitution in headers and body

## Anthropic Credentials

The proxy supports two auth modes, auto-detected from `.env`:

| Mode | `.env` variable | Header sent | When to use |
|------|----------------|-------------|-------------|
| **API key** | `ANTHROPIC_API_KEY=sk-ant-api03-...` | `x-api-key` | Direct API keys from console.anthropic.com |
| **OAuth** | `ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...` | `Authorization: Bearer` | OAuth tokens (e.g. from `claude setup-token`) |

**Detection logic:** If `ANTHROPIC_API_KEY` is set, the proxy uses api-key mode. Otherwise it falls back to OAuth mode using `ANTHROPIC_AUTH_TOKEN` (or `CLAUDE_CODE_OAUTH_TOKEN`).

### Option A: Claude Subscription (Pro/Max)

1. In a separate terminal, run `claude setup-token` and complete the flow
2. Copy the token from Claude Code's credential store:

```bash
python -c "
import json
d = json.load(open('$HOME/.claude/.credentials.json'))
print(d['claudeAiOauth']['accessToken'])
"
```

3. Add to `.env`:

```bash
ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-your-token
```

**Important:** Use `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. OAuth tokens sent as `x-api-key` will fail with "Invalid API key".

### Option B: Anthropic API Key

1. Get a key from https://console.anthropic.com/settings/keys
2. Add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-your-key
```

### Refreshing an expired token

OAuth tokens expire. Today, ClawDad re-reads Claude Code's credential store on each request, but it still relies on a valid access token being present there or in `.env`.

If the running service has been idle for a while and starts returning `401 Invalid authentication credentials`, refresh the Claude login first:

1. Run `claude setup-token` again if needed
2. Confirm `~/.claude/.credentials.json` contains a fresh `accessToken`
3. Retry the request or restart ClawDad if the service is stuck on an older auth state

Current limitation:

- ClawDad does **not** yet use Claude Code's refresh token directly.
- That means the service can hit a stale-token window after long idle periods, especially in OAuth mode.
- A stronger long-term fix is to adopt a helper-based or refresh-aware auth flow instead of treating the access token as the durable credential.

## Custom Anthropic Endpoint

If you use a proxy or custom endpoint instead of `api.anthropic.com`:

```bash
ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

## Adding Other Service Credentials

Service credentials (GitHub, GitLab, Jira, etc.) are passed directly to containers as environment variables. Add them to `.env`:

```bash
# GitHub
GITHUB_TOKEN=ghp_your-token

# GitLab
GITLAB_TOKEN=glpat-your-token

# Atlassian (email + API token)
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=your-api-token

# LaunchDarkly
LAUNCHDARKLY_API_KEY=your-ld-key
```

Variables matching `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD` are automatically forwarded to containers (excluding `ANTHROPIC_*` and `CLAUDE_CODE_*` which go through the proxy).

## Env Passthrough: Secrets vs Config

NanoClaw separates credentials from configuration:

- **Anthropic credentials** flow through the credential proxy. They never enter containers directly.
- **Service credentials** (tokens, keys) are passed as environment variables to containers.
- **Config** (URLs, account IDs, email addresses) is also passed via env vars through `PASSTHROUGH_ENV_PREFIXES` in `container-runner.ts`.

The passthrough list includes variables matching these prefixes:

| Prefix | Example Variables |
|--------|-------------------|
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL |
| `GITLAB_` | `GITLAB_URL` |
| `GITHUB_` | `GITHUB_ORG` |
| `LAUNCHDARKLY_` | `LAUNCHDARKLY_PROJECT` |
| `FIGMA_` | `FIGMA_API_KEY` |
| `ATLASSIAN_` | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL` |

## In-Chat Credential Registration (IPC)

Agents can register credentials on behalf of users — the user enters their token in a secure browser popup, and it's saved to `.env` via IPC.

### How It Works

```
User clicks popup  --->  Browser form  --->  IPC file (ephemeral)
                                                   |
Host IPC watcher  <---  picks up file, deletes  <--+
       |
       v
Saved to .env  --->  Available on next proxy/container restart
```

1. Agent calls `request_credential` MCP tool — opens a secure popup in the browser
2. User enters their secret in the form (the agent never sees it)
3. Script writes a JSON file to the IPC credentials directory
4. Host IPC watcher picks up the file and **immediately deletes it**
5. Host saves the credential to `.env`
6. Host writes a result file back so the agent can confirm success

### Supported Services

| Service | Env Variable | Default Host Pattern |
|---------|-------------|---------------------|
| `atlassian` | `ATLASSIAN_API_TOKEN` + `ATLASSIAN_EMAIL` | `*.atlassian.net` |
| `gitlab` | `GITLAB_TOKEN` | `gitlab.com` |
| `github` | `GITHUB_TOKEN` | `*.github.com` |
| `launchdarkly` | `LAUNCHDARKLY_API_KEY` | `app.launchdarkly.com` |

### Security Properties

- The token is on disk for at most one IPC poll cycle (~2s)
- The IPC file is deleted before processing
- The token is never stored in `agent-config.json` or any persistent file
- Agents never see raw Anthropic credentials — the proxy injects them

## Verification

Check that credentials are configured:

```bash
# Check .env has credentials
grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' .env

# Check credential proxy health
curl -s http://localhost:3456/api/health | python -m json.tool

# After starting ClawDad, check logs for:
# "Credential proxy started" with authMode
```

## Troubleshooting

### "Invalid API key"

**Common cause:** An OAuth token (`sk-ant-oat01-...`) is set as `ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN`. The proxy sends it as `x-api-key` instead of `Authorization: Bearer`.

**Fix:** Move the token to the correct variable:
```bash
# In .env, change:
#   ANTHROPIC_API_KEY=sk-ant-oat01-...
# To:
#   ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...
```
Then restart ClawDad.

### "Invalid API key" with a custom endpoint

**Cause:** `ANTHROPIC_BASE_URL` in `.env` doesn't match where the credential is valid.

**Fix:** Ensure `ANTHROPIC_BASE_URL` points to the correct endpoint for your key.

### "Not logged in" or "Please run /login"

**Cause:** No Anthropic credential found in `.env`.

**Fix:** Add either `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to `.env` and restart.

### Token expired after working previously

**Cause:** OAuth access tokens can expire while the service is idle. ClawDad currently re-reads the token file, but it does not perform its own refresh-token exchange.

**Fix:** Refresh the Claude login (`claude setup-token` if needed), verify `~/.claude/.credentials.json` has a fresh `accessToken`, then retry. If the service still fails, restart ClawDad.
