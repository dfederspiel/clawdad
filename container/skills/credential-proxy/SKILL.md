---
name: credential-proxy
description: How to make authenticated API calls to external services. Covers api.sh, auth patterns, available credentials, cloning repos, and troubleshooting 401s. Read this before calling any external API.
---

# Credential Proxy — Authenticated API Access

All external API calls go through the credential proxy via `/workspace/scripts/api.sh`. The proxy injects real credentials at request time — your environment variables contain **placeholders**, not real secrets.

## The One Rule

**ALWAYS use `/workspace/scripts/api.sh`** for authenticated requests. Never use raw `curl`, `gh`, `git clone` with SSH, or any other tool that bypasses the proxy.

```bash
/workspace/scripts/api.sh <service_label> <METHOD> <URL> [CURL_ARGS...]
```

The first argument is a service label (for logging). The rest is passed to `curl`.

## Available Services

Check what's configured in your container:

```bash
env | grep -E '_(TOKEN|KEY|SECRET|URL|EMAIL)=' | sed 's/=.*//' | sort
```

## Auth Patterns by Service

### GitHub

```bash
# List repos
/workspace/scripts/api.sh github GET "https://api.github.com/repos/OWNER/REPO" \
  -H "Authorization: token $GITHUB_TOKEN"

# Read file contents
/workspace/scripts/api.sh github GET "https://api.github.com/repos/OWNER/REPO/contents/PATH" \
  -H "Authorization: token $GITHUB_TOKEN"

# List PRs
/workspace/scripts/api.sh github GET "https://api.github.com/repos/OWNER/REPO/pulls?state=open" \
  -H "Authorization: token $GITHUB_TOKEN"
```

### GitLab

```bash
# List projects
/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects?membership=true" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"

# List merge requests
/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/PROJECT_ID/merge_requests?state=opened" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"
```

### Atlassian (Jira / Confluence)

**IMPORTANT:** `/rest/api/3/search` is deprecated (returns 410). Use `/rest/api/3/search/jql` with POST instead.

```bash
INSTANCE="$ATLASSIAN_BASE_URL"

# Search Jira issues (POST — required for /search/jql)
/workspace/scripts/api.sh atlassian POST "${INSTANCE}/rest/api/3/search/jql" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  -d '{"jql": "project = PROJ AND assignee = currentUser() ORDER BY updated DESC", "fields": ["summary", "status", "updated"], "maxResults": 20}'

# Get a single issue
/workspace/scripts/api.sh atlassian GET "${INSTANCE}/rest/api/3/issue/PROJ-123" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN"

# Read a Confluence page
/workspace/scripts/api.sh atlassian GET "${INSTANCE}/wiki/rest/api/content/PAGE_ID?expand=body.storage" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN"
```

### Harness

```bash
/workspace/scripts/api.sh harness GET "https://app.harness.io/ng/api/..." \
  -H "x-api-key: $HARNESS_API_KEY"
```

### LaunchDarkly

```bash
/workspace/scripts/api.sh launchdarkly GET "https://app.launchdarkly.com/api/v2/flags/PROJECT_KEY" \
  -H "Authorization: $LAUNCHDARKLY_API_KEY"
```

### BlackDuck

```bash
/workspace/scripts/api.sh blackduck GET "$BLACKDUCK_URL/api/..." \
  -H "Authorization: token $BLACKDUCK_API_TOKEN"
```

### Custom / Other Services

Use any label — the proxy doesn't restrict service names:

```bash
/workspace/scripts/api.sh my-service GET "https://api.example.com/endpoint" \
  -H "Authorization: Bearer $MY_SERVICE_TOKEN"
```

## Cloning Repositories

**Do NOT use `git clone` with SSH** — your container has no SSH keys.

Options:
1. **GitHub API** — read files directly (best for a few files):
   ```bash
   /workspace/scripts/api.sh github GET "https://api.github.com/repos/OWNER/REPO/contents/path/to/file" \
     -H "Authorization: token $GITHUB_TOKEN" | jq -r '.content' | base64 -d
   ```

2. **HTTPS clone with token** — for full repo access:
   ```bash
   git clone https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git /workspace/group/repo-name
   ```
   Note: The `$GITHUB_TOKEN` placeholder won't be substituted in `git clone` (it doesn't go through the proxy). If you need to clone, ask the user to provide the local path and mount it via `containerConfig.additionalMounts`.

3. **Ask for a local mount** — if the user has the repo on their machine:
   > I can't clone repos directly from inside my container. Could you tell me the local path to the repo? I'll set it up as an additional mount.

## Registering New Credentials

If a service returns 401 and you've confirmed you're using `api.sh` with the right auth header:

```
Use mcp__nanoclaw__request_credential with:
- service: "service-name"
- description: "Why this credential is needed"
```

This opens a popup in the user's browser. The credential is available immediately — no restart needed. A `[credential_registered]` message appears in chat when complete.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 Unauthorized | Not using `api.sh` | Switch from raw `curl` to `api.sh` |
| 401 Unauthorized | Missing auth header | Add `-H "Authorization: token $TOKEN"` or equivalent |
| 401 Unauthorized | Credential expired/missing | Use `request_credential` to re-register |
| 410 Gone | Deprecated Jira endpoint | Use `/rest/api/3/search/jql` POST instead of `/rest/api/3/search` GET |
| Connection refused | Wrong base URL | Check `env \| grep _URL` for the correct service URL |
| Empty response | Placeholder not substituted | Verify the env var name matches exactly (case-sensitive) |

## Key Rules

1. **Always `api.sh`** — never raw `curl` for authenticated calls
2. **Always pass auth headers** — the proxy substitutes placeholders, it doesn't add headers
3. **Never echo credentials** — env vars contain placeholders, but don't log them anyway
4. **Never ask users to paste tokens** — use `request_credential` instead
5. **Try first, ask second** — attempt the API call before requesting new credentials
