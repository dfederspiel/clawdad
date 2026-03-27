# Credential Management

NanoClaw uses **OneCLI Agent Vault** to manage API credentials. The vault is a local gateway that intercepts outbound HTTPS requests from agent containers and injects the correct credentials at request time. Agents never see raw API keys or tokens.

## How It Works

```
Agent Container  --->  OneCLI Gateway (port 10254)  --->  External API
                       (injects credentials)
```

1. You register secrets with OneCLI (API keys, OAuth tokens)
2. Each secret has a **host pattern** (e.g., `api.anthropic.com`)
3. When a container makes an HTTPS request matching that pattern, the gateway injects the credential
4. The container itself has no access to the raw key

## Installation

Install the OneCLI gateway and CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

If `onecli` is not found after installation, add `~/.local/bin` to your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Verify: `onecli version`

## Configuration

Point the CLI at the local gateway:

```bash
onecli config set api-host http://127.0.0.1:10254
```

Add the gateway URL to your `.env`:

```bash
ONECLI_URL=http://127.0.0.1:10254
```

Start the gateway:

```bash
onecli gateway start
```

Verify it's running:

```bash
curl -sf http://127.0.0.1:10254/health
```

## Registering Anthropic Credentials

### Option A: Claude Subscription (Pro/Max)

1. In a separate terminal, run `claude setup-token` and copy the token it outputs
2. Register the token:

```bash
onecli secrets create \
  --name Anthropic \
  --type anthropic \
  --value YOUR_TOKEN \
  --host-pattern api.anthropic.com
```

### Option B: Anthropic API Key

1. Get a key from https://console.anthropic.com/settings/keys
2. Register it:

```bash
onecli secrets create \
  --name Anthropic \
  --type anthropic \
  --value sk-ant-your-key \
  --host-pattern api.anthropic.com
```

## Custom Anthropic Endpoint

If you use a proxy or custom endpoint instead of `api.anthropic.com`, **two things** must be configured:

1. **Set the endpoint in `.env`** so containers know where to send requests:

```bash
ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

2. **Set the OneCLI host pattern** to match your endpoint:

```bash
# If you already have an Anthropic secret, update its host pattern:
onecli secrets list                    # find the secret ID
onecli secrets update --id ID --host-pattern your-proxy.example.com

# Or create a new secret with the correct pattern:
onecli secrets create \
  --name Anthropic \
  --type anthropic \
  --value YOUR_TOKEN \
  --host-pattern your-proxy.example.com
```

**Both steps are required.** If `ANTHROPIC_BASE_URL` is missing from `.env`, containers default to `api.anthropic.com` and the gateway can't match your custom host pattern. This causes a silent "Invalid API key" error.

## Adding Other Service Credentials

For non-Anthropic services (GitLab, Harness, Jira, etc.), use `--type generic` with the correct HTTP header:

```bash
# GitLab (PRIVATE-TOKEN header)
onecli secrets create \
  --name GitLab \
  --type generic \
  --value glpat-your-token \
  --host-pattern gitlab.example.com \
  --header-name PRIVATE-TOKEN

# Harness (x-api-key header)
onecli secrets create \
  --name Harness \
  --type generic \
  --value your-harness-key \
  --host-pattern app.harness.io \
  --header-name x-api-key

# Atlassian/Jira (Basic auth via Authorization header)
# Value must be base64(email:api-token) — OneCLI adds the "Basic " prefix via --value-format
ENCODED=$(echo -n 'you@example.com:your-api-token' | base64)
onecli secrets create \
  --name Atlassian \
  --type generic \
  --value "$ENCODED" \
  --host-pattern your-team.atlassian.net \
  --header-name Authorization \
  --value-format "Basic {value}"

# GitHub (Authorization: token header)
onecli secrets create \
  --name GitHub \
  --type generic \
  --value "token ghp_your-token" \
  --host-pattern api.github.com \
  --header-name Authorization

# Black Duck (Authorization: token header)
onecli secrets create \
  --name BlackDuck \
  --type generic \
  --value "token your-bd-token" \
  --host-pattern your-instance.blackduck.com \
  --header-name Authorization

# LaunchDarkly (Authorization header)
onecli secrets create \
  --name LaunchDarkly \
  --type generic \
  --value your-ld-key \
  --host-pattern app.launchdarkly.com \
  --header-name Authorization
```

## Env Passthrough: Secrets vs Config

NanoClaw separates credentials from configuration:

- **Secrets** (API keys, tokens) flow through the OneCLI gateway. They never enter containers.
- **Config** (URLs, account IDs, email addresses) is passed to containers as environment variables via `PASSTHROUGH_ENV_PREFIXES` in `container-runner.ts`.

The passthrough list includes variables matching these prefixes:

| Prefix | Example Variables |
|--------|-------------------|
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL |
| `HARNESS_` | `HARNESS_ACCOUNT_ID` |
| `GITLAB_` | `GITLAB_URL` |
| `GITHUB_` | `GITHUB_ORG` |
| `BLACKDUCK_` | `BLACKDUCK_URL` |
| `LAUNCHDARKLY_` | `LAUNCHDARKLY_PROJECT` |
| `FIGMA_` | `FIGMA_API_KEY` |
| `ATLASSIAN_` | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL` |

To add a new service, add its prefix to `PASSTHROUGH_ENV_PREFIXES` in `src/container-runner.ts` and register its credential with OneCLI.

## Verification

Check that OneCLI is configured:

```bash
# List registered secrets
onecli secrets list

# Check gateway health
curl -sf http://127.0.0.1:10254/health

# After starting NanoClaw, check logs for:
# "OneCLI gateway config applied" — credentials will be injected
# "OneCLI gateway not reachable" — gateway is down
```

## Troubleshooting

### "Invalid API key" with a custom Anthropic endpoint

**Cause:** `ANTHROPIC_BASE_URL` is not set in `.env`, so containers default to `api.anthropic.com`. The OneCLI secret's host pattern points to your custom endpoint, so the gateway never matches.

**Fix:** Add `ANTHROPIC_BASE_URL=https://your-endpoint` to `.env` and ensure the OneCLI secret's host pattern matches: `onecli secrets update --id ID --host-pattern your-endpoint`.

### "Not logged in" or "Please run /login"

**Cause:** The OneCLI gateway is not running, so containers have no credentials.

**Fix:** Start the gateway: `onecli gateway start`. Verify: `curl -sf http://127.0.0.1:10254/health`.

### "container will have no credentials" in logs

**Cause:** The gateway is unreachable when the container starts.

**Fix:** Ensure the gateway is running and `ONECLI_URL` in `.env` points to the correct address (default: `http://127.0.0.1:10254`).

### Port 10254 already in use

**Cause:** Another OneCLI instance is running.

**Fix:** `lsof -i :10254` to find the process. Kill it or use a different port.

### Atlassian returns 401 "Client must be authenticated"

**Cause:** The OneCLI secret stores the raw API token, but Atlassian Basic auth requires `base64(email:token)`. Unlike `curl -u` (which auto-encodes), OneCLI injects the value literally.

**Fix:** Recreate the secret with a pre-encoded value:

```bash
onecli secrets delete --id $(onecli secrets list | python3 -c "import sys,json; print(next(s['id'] for s in json.load(sys.stdin) if s['name']=='Atlassian'))")
ENCODED=$(echo -n 'you@example.com:your-api-token' | base64)
onecli secrets create --name Atlassian --type generic --value "$ENCODED" \
  --host-pattern your-team.atlassian.net --header-name Authorization \
  --value-format "Basic {value}"
```

### Generic secret fails with "Header name is required"

**Cause:** Generic secrets need `--header-name` to know which HTTP header to inject.

**Fix:** Add `--header-name` to the create command (see examples above).

## In-Chat Credential Registration (IPC)

Agents can register credentials on behalf of users during setup — the user shares their token in chat, the agent registers it in the OneCLI vault via IPC, and the token is never stored on disk.

### How It Works

```
User shares PAT  --->  Agent calls register-credential.sh  --->  IPC file (ephemeral)
                                                                      |
Host IPC watcher  <---  picks up file, deletes immediately  <---------+
       |
       v
onecli secrets create  --->  OneCLI Vault  --->  Injected at request time
```

1. User shares their API token/PAT in the chat
2. Agent calls `/workspace/scripts/register-credential.sh` with the token
3. Script writes a JSON file to `/workspace/ipc/credentials/` (inside the container)
4. Host IPC watcher picks up the file and **immediately deletes it** (secret is in-flight for at most one poll cycle, ~2s)
5. Host calls `onecli secrets create` to register the secret in the vault
6. Host writes a result file back so the agent can confirm success
7. Future API calls from the container are automatically authenticated by the gateway

### Supported Services

| Service | Header | Default Host Pattern |
|---------|--------|---------------------|
| `atlassian` | `Authorization: Basic {base64(email:token)}` | `*.atlassian.net` |
| `gitlab` | `PRIVATE-TOKEN` | `gitlab.com` |
| `github` | `Authorization: token {value}` | `*.github.com` |
| `harness` | `x-api-key` | `app.harness.io` |
| `launchdarkly` | `Authorization` | `app.launchdarkly.com` |

### Container-Side Script

```bash
# Atlassian (requires --email for basic auth encoding)
/workspace/scripts/register-credential.sh atlassian "api-token" --email "user@co.com" --wait

# GitLab (custom host)
/workspace/scripts/register-credential.sh gitlab "glpat-xxxx" --host-pattern "gitlab.mycompany.com" --wait

# GitHub
/workspace/scripts/register-credential.sh github "ghp_xxxx" --wait

# Harness
/workspace/scripts/register-credential.sh harness "pat.xxxx" --wait
```

The `--wait` flag blocks until the host confirms registration (up to 30s).

### Security Properties

- The token is on disk for at most one IPC poll cycle (~2s)
- The IPC file is deleted before processing, not moved to an error directory
- The token is never stored in `agent-config.json` or any persistent file
- OneCLI vault handles actual storage and per-request injection
- Agents never see raw credentials after registration — the gateway injects them

### Template Integration

All agent templates (deployments, bug-triage, updates) include credential registration instructions. When an API call returns 401/403, the agent asks the user for their token and registers it via this mechanism. See `templates/*/CLAUDE.md` for the exact instructions.

## Alternative: Native Credential Proxy

For simpler single-user setups, NanoClaw offers a built-in credential proxy that reads directly from `.env`. Apply the skill branch:

```bash
git merge origin/skill/native-credential-proxy
npm run build
```

This is simpler but less secure — credentials live in `.env` and are proxied through a single HTTP endpoint. OneCLI is recommended for production use.
