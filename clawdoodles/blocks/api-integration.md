---
id: api-integration
teaches: "HTTP API calls via api.sh, auth wrappers, error handling"
tools: [api.sh, auth-args.sh]
complexity: intermediate
depends_on: [credential-management]
---

## API Integration

Agents can call external APIs using wrapper scripts that handle authentication, logging, and error tracking.

### Universal HTTP wrapper

```bash
# GET request
/workspace/scripts/api.sh github GET "https://api.github.com/repos/org/repo/pulls"

# POST request with JSON body
/workspace/scripts/api.sh my-service POST "https://api.example.com/data" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

The first argument is the service name (matches the credential registered in the vault). The script auto-injects authentication and logs all requests to `/workspace/group/api-logs/`.

### Atlassian (Jira / Confluence)

Read the instance URL from `agent-config.json` (`atlassian_instance`). Pass the full URL to `api.sh`:

```bash
INSTANCE="https://your-team.atlassian.net"  # from config

# GET from Jira
/workspace/scripts/api.sh atlassian GET "${INSTANCE}/rest/api/3/myself"

# POST to Jira (e.g., search)
/workspace/scripts/api.sh atlassian POST "${INSTANCE}/rest/api/3/search/jql" \
  -H "Content-Type: application/json" \
  -d '{"jql":"project = PROJ AND updated >= -1d ORDER BY updated DESC","maxResults":10}'
```

Authentication is handled automatically by the credential proxy — `api.sh` routes through it when `CRED_PROXY_URL` is set.

### Auth helpers

Source `auth-args.sh` for manual auth header injection:

```bash
source /workspace/scripts/auth-args.sh
curl -s $(github_token) "https://api.github.com/user"
```

### Error handling

- Exit code 0 = success
- Exit code 1 = HTTP error (4xx/5xx)
- Exit code 2 = connection failure

The wrapper tracks consecutive failures. After 3+ failures for the same service, stop retrying and alert the user:

:::blocks
[{"type":"alert","level":"error","title":"API Connection Issue","body":"Failed to reach [service] 3 times in a row. This usually means the service is down or credentials expired.\n\nSay \"reconnect [service]\" to troubleshoot."}]
:::

### Polling pattern

For periodic API checks, compare current results against saved state:

```bash
# Save current state after each poll
echo "$RESPONSE" > /workspace/group/last-poll.json

# On next poll, compare
diff <(jq -S . /workspace/group/last-poll.json) <(echo "$RESPONSE" | jq -S .)
```
