---
name: api-errors
description: Review Atlassian API error logs. Shows failed requests with status codes, endpoints, and error messages. Use to identify patterns, optimize prompts, and reduce retries.
---

# /api-errors — API Error Report

Analyze the API error logs and produce a summary report.

## How to Run

```bash
# Errors only (failures with response bodies)
cat /workspace/group/api-logs/atlassian.jsonl 2>/dev/null || echo "No errors logged yet."

# Full request log (all calls, success and failure)
cat /workspace/group/api-logs/all-requests.jsonl 2>/dev/null || echo "No requests logged yet."
```

## Report Format

Produce a summary like:

```
*API Health Report*

*Total requests*: X (Y errors, Z% failure rate)

*Error breakdown:*
• 400 Bad Request (N times)
  - POST /rest/api/3/issue — missing required field customfield_10075
  - PUT /rest/api/3/issue/POLUIG-XXX — invalid priority format
• 401 Unauthorized (N times)
  - Likely token expiry or rotation needed
• 404 Not Found (N times)
  - GET /rest/api/3/issue/POLUIG-XXX — ticket may have been deleted

*Recommendations:*
• [Actionable fix for each recurring error pattern]
```

## What to Look For

- **400 errors**: Usually wrong field format. Check the error body for which field failed and why. Cross-reference with the `jira-ticket` skill for correct formats.
- **401 errors**: Token expired or wrong credentials. Flag to user.
- **403 errors**: Permission issue. The API token may lack access to the resource.
- **404 errors**: Resource doesn't exist. Could be wrong issue key or deleted page.
- **429 errors**: Rate limited. Suggest adding delays between bulk operations.
- **Repeated same-endpoint failures**: Likely a skill/CLAUDE.md needs updating with correct field formats.

## After Analysis

If you identify a recurring error pattern that could be prevented by updating instructions:
1. Describe the fix needed
2. Offer to update the relevant CLAUDE.md or skill file
3. Note it so the pattern doesn't repeat
