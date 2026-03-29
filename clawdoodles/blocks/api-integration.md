---
id: api-integration
teaches: "HTTP API calls via api.sh, auth wrappers, error handling"
tools: [api.sh, atlassian-api.sh, auth-args.sh]
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

### Atlassian-specific wrapper

```bash
# GET from Jira
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/myself"

# POST to Jira (e.g., search)
/workspace/scripts/atlassian-api.sh POST "/rest/api/3/search/jql" \
  -d '{"jql":"project = PROJ AND updated >= -1d ORDER BY updated DESC","maxResults":10}'
```

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
