---
name: jira-ticket
description: Create and manage Jira tickets in the POLUIG (Central UI Engineering) project. Handles required custom fields including Bug-specific Severity and Environment fields. All API calls go through the atlassian-api wrapper for error logging.
---

# /jira-ticket — Jira Ticket Management for POLUIG

## Instance Configuration

- **Instance URL**: `https://blackduck.atlassian.net`
- **Auth**: Basic auth via `$ATLASSIAN_EMAIL` and `$ATLASSIAN_API_TOKEN` env vars

## API Access

**Always use the wrapper script** — it handles auth, logs every request, and captures failures for analysis:

```bash
/workspace/scripts/atlassian-api.sh METHOD PATH [CURL_ARGS...]
```

### Search issues (JQL):
```bash
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/search" \
  --data-urlencode "jql=YOUR_JQL_HERE" \
  --data-urlencode "fields=summary,status,assignee,priority" \
  --data-urlencode "maxResults=20"
```

### Get issue:
```bash
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/issue/POLUIG-XXXX"
```

### Confluence search (CQL):
```bash
/workspace/scripts/atlassian-api.sh GET "/wiki/rest/api/content/search" \
  --data-urlencode "cql=YOUR_CQL_HERE" \
  --data-urlencode "limit=10"
```

### Get Confluence page:
```bash
/workspace/scripts/atlassian-api.sh GET "/wiki/rest/api/content/PAGE_ID?expand=body.storage"
```

### Create issue:
```bash
/workspace/scripts/atlassian-api.sh POST "/rest/api/3/issue" \
  -d "$JSON_PAYLOAD"
```

### Update issue:
```bash
/workspace/scripts/atlassian-api.sh PUT "/rest/api/3/issue/POLUIG-XXXX" \
  -d "$JSON_PAYLOAD"
```

### Transition issue:
```bash
/workspace/scripts/atlassian-api.sh POST "/rest/api/3/issue/POLUIG-XXXX/transitions" \
  -d '{"transition":{"id":"TRANSITION_ID"}}'
```

### Add comment:
```bash
/workspace/scripts/atlassian-api.sh POST "/rest/api/3/issue/POLUIG-XXXX/comment" \
  -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Comment text"}]}]}}'
```

### API Logs
- Errors: `/workspace/group/api-logs/atlassian.jsonl`
- All requests: `/workspace/group/api-logs/all-requests.jsonl`

## Default Project: POLUIG

| Field | Value |
|-------|-------|
| Project Key | `POLUIG` |
| Project ID | `10192` |
| Project Name | Central UI Engineering |
| Default Issue Type | `Task` |

## CRITICAL: Always Include These Fields

Every ticket MUST include:

```json
{
  "fields": {
    "project": {"key": "POLUIG"},
    "issuetype": {"name": "Task"},
    "summary": "...",
    "description": {"type": "doc", "version": 1, "content": [...]},
    "customfield_10001": "86dc8a10-0c4d-4396-a00a-0b43edbc2ca8",
    "labels": ["bd-assist"],
    "components": [{"id": "17438"}]
  }
}
```

## CRITICAL: Do NOT Set Priority

The Jira API rejects `priority` in any format. Omit it entirely — let Jira use the default.

## CRITICAL: Bug-Specific Required Fields

When creating a **Bug**, you MUST include Severity and Polaris Environment Affected or the API returns 400:

```json
{
  "customfield_10075": {"id": "10251"},
  "customfield_10121": {"id": "10539"}
}
```

### Severity Options (customfield_10075)

| Severity | ID |
|----------|-----|
| Extremely Critical | `10247` |
| Critical | `10248` |
| High | `10249` |
| Medium | `10250` |
| Low | `10251` |

### Polaris Environment Affected (customfield_10121)

| Environment | ID |
|-------------|-----|
| Pre-Merge | `10538` |
| Development | `10539` |
| QA | `10540` |
| UAT | `10541` |
| Production Staging | `10542` |

Default to Low severity and Development environment if not specified.

## Other Useful Fields

| Field | Field ID | Format | Example |
|-------|----------|--------|---------|
| Team | `customfield_10001` | Plain string | `"86dc8a10-0c4d-4396-a00a-0b43edbc2ca8"` |
| Epic Link | `customfield_10014` | Plain string | `"POLDELIVER-2898"` |
| Story Points | `customfield_10045` | Number | `3` |
| Sprint | `customfield_10020` | Plain number (NOT object) | `25144` |
| Software Component | `customfield_10064` | Array of objects | `[{"id": "16060"}]` |
| Start date | `customfield_10015` | Date string | `"2026-03-11"` |
| End date | `customfield_10238` | Date string | `"2026-03-15"` |
| Due date | `customfield_10294` | Date string | `"2026-03-15"` |
| Assignee | `assignee` | Object | `{"accountId": "712020:ab551819-e15b-4903-bfec-3c8c11ab547b"}` |

### Sprint Field Warning

Sprint format: `"customfield_10020": 25144` — plain integer. Using `{"id": 25144}` causes "Number value expected" error.

### Sprint Discovery

```bash
# Find active sprint via JQL
curl -s -G "https://blackduck.atlassian.net/rest/api/3/search" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  --data-urlencode "jql=project = POLUIG AND sprint in openSprints()" \
  --data-urlencode "fields=customfield_10020" \
  --data-urlencode "maxResults=1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sprints=d['issues'][0]['fields']['customfield_10020']
for s in sprints:
  if s.get('state')=='active':
    print(f\"Sprint: {s['name']} (ID: {s['id']})\")"
```

## Valid Issue Types

Task, Bug, Technical Analysis, Research Spike

**"Story" is NOT valid in POLUIG** — use "Task" for feature work.

## Common Software Components (customfield_10064)

| Component | ID |
|-----------|-----|
| AI Assist Service | `16060` |
| Web Application (Polaris/CoP) | `10176` |

## Teams Reference

| Team Name | Team ID |
|-----------|---------|
| Central UI Team | `86dc8a10-0c4d-4396-a00a-0b43edbc2ca8` |
| Core Services Team | `f4c407ba-782d-452a-a56f-2ba705095533` |
| Polaris Core Team | `66fff34f-c065-4bd9-a3c6-1fe046262d87` |
| Issue Management Team | `4b5169d0-0a42-483e-9011-088af71af940` |
| Insights Team | `e37c3dad-3931-4738-997c-b32f520b1510` |

## Team Member Account IDs

| Name | Account ID |
|------|-----------|
| David Federspiel | `712020:ab551819-e15b-4903-bfec-3c8c11ab547b` |
| Dylan Halperin | `712020:4fa2fe69-1dba-40b6-8a55-c0978776d5cd` |
| Allison Lee | `712020:96dfd7a1-313e-4a3d-b498-d14881c96da1` |
| Luc Morrissette | `6093f8c9eebe78006a76134d` |
| Andrew Scudder | `5fa42f5f58f262007283341e` |
| Andrei Luchian | `712020:b3dbcd03-00f4-4176-b715-1c03da38278d` |
| Ajaya Dash | `63348112140ba0bf651bf608` |

## Confluence Space

| Space Key | Space ID | Name |
|-----------|----------|------|
| CENTRALUITEAM | `1946584645` | Central UI Team |

## Workflow Transitions

```
To Do → In Progress → Code Review → Development Done → Closed
```

| From | Transition Name | Transition ID | Target Status |
|------|----------------|---------------|---------------|
| To Do | In Progress | `241` | In Progress |
| In Progress | Code Review | `251` | Code Review |
| In Progress | Development Done | `361` | Development Done |
| Code Review | Development Done | `361` | Development Done |
| Development Done | Closed | `341` | Closed |

### Global Transitions (from any status)

| Transition Name | Transition ID | Target Status |
|----------------|---------------|---------------|
| Blocked | `81` | Blocked |
| Waiting for customer | `311` | Waiting for customer |

Notes:
- "Closed" transition has `hasScreen: true` — may require additional fields via UI
- "Closed" is effectively "Deployed" — the final state
- For retroactive tickets, rapid-transition: To Do → In Progress → Code Review → Development Done

## Description Format (ADF — Atlassian Document Format)

The v3 API requires ADF for descriptions, not plain text:

```json
{
  "description": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          {"type": "text", "text": "Description text here"}
        ]
      }
    ]
  }
}
```

For headings, bullets, code blocks, see: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

## Complete Create Example

```bash
curl -s -X POST "https://blackduck.atlassian.net/rest/api/3/issue" \
  -H "Content-Type: application/json" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  -d '{
  "fields": {
    "project": {"key": "POLUIG"},
    "issuetype": {"name": "Task"},
    "summary": "Example task title",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Task description here."}]}
      ]
    },
    "customfield_10001": "86dc8a10-0c4d-4396-a00a-0b43edbc2ca8",
    "labels": ["bd-assist"],
    "components": [{"id": "17438"}],
    "assignee": {"accountId": "712020:ab551819-e15b-4903-bfec-3c8c11ab547b"}
  }
}'
```

Response includes `key` (e.g., `POLUIG-1234`) and `self` URL.

## Post-Creation Checklist

After creating a ticket, offer to:
1. Add story points: `"customfield_10045": 3`
2. Add to current sprint: find active sprint ID, set `"customfield_10020": <sprint_id>`
3. Transition through workflow if work is already done
4. Link to an epic: `"customfield_10014": "POLDELIVER-XXXX"`
