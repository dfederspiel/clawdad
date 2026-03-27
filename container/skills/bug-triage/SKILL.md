---
name: bug-triage
description: On-demand triage of a specific Jira bug. Searches mounted codebases for likely root cause and posts findings as a Jira comment.
---

# /bug-triage — Ad-hoc Bug Triage

Triage a specific POLUIG bug ticket on demand.

## Usage

```
/bug-triage POLUIG-1234
```

## Workflow

1. **Fetch the issue**

```bash
/workspace/scripts/atlassian-api.sh GET "/rest/api/3/issue/$ISSUE_KEY"
```

Extract: summary, description, comments, severity, environment, components, reporter, linked issues.

2. **Search the codebases**

The following repos may be mounted at `/workspace/extra/`:

| Repo | Path |
|------|------|
| polaris-ui | `/workspace/extra/polaris-ui` |
| polaris-react-composition | `/workspace/extra/polaris-react-composition` |

Search strategy:
- Extract error messages, component names, keywords from the bug description
- `grep -r "<keyword>" /workspace/extra/polaris-ui/packages/ --include="*.ts" --include="*.tsx" -l | head -20`
- Read the most relevant files
- `cd /workspace/extra/polaris-ui && git log --oneline --since="2 weeks ago" -- <path>`

3. **Write triage analysis**

Produce:
- **Suspected Component** and file path
- **Confidence**: High / Medium / Low
- **Suspected Root Cause**: 2-3 sentences
- **Relevant Code Paths**: specific files and functions
- **Recent Related Commits**: from git log
- **Recommended Next Steps**: debugging suggestions, suggested assignee (use `git blame`)

4. **Post to Jira**

Add analysis as a comment (ADF format):

```bash
/workspace/scripts/atlassian-api.sh POST "/rest/api/3/issue/$ISSUE_KEY/comment" \
  -H "Content-Type: application/json" \
  -d "$COMMENT_JSON"
```

Add the `triage-analyzed` label:

```bash
/workspace/scripts/atlassian-api.sh PUT "/rest/api/3/issue/$ISSUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"update":{"labels":[{"add":"triage-analyzed"}]}}'
```

5. **Report to chat** with a summary including the ticket link.

## Event Logging

**You MUST log triage events using `/workspace/scripts/event-log.sh` as each step completes.** This builds the audit trail for triage reports.

### Event types and fields

```bash
# Started triaging a ticket
/workspace/scripts/event-log.sh triage_started \
  ticket=<POLUIG-1234> \
  severity=<critical|major|normal|minor> \
  component="<component_name>"

# Completed code search phase
/workspace/scripts/event-log.sh triage_searched \
  ticket=<POLUIG-1234> \
  repos_searched=<N> \
  files_matched=<N> \
  suspected_component="<component or file path>"

# Analysis posted to Jira
/workspace/scripts/event-log.sh triage_completed \
  ticket=<POLUIG-1234> \
  confidence=<high|medium|low> \
  suspected_component="<component or file path>" \
  comment_posted=<true|false> \
  label_added=<true|false>

# Triage failed or was skipped
/workspace/scripts/event-log.sh triage_skipped \
  ticket=<POLUIG-1234> \
  reason="<brief reason, e.g. ticket not found, no mounted repos>"
```

### Rules

- **Log what you do, when you do it.** Don't batch events for later.
- **Omit fields you don't have** — just skip unknown fields rather than passing empty strings.
- **Use the exact event names above** so reports can aggregate consistently.
- **Don't log container lifecycle** — the host already handles `container_started`/`container_completed`.
- **Don't log raw API errors** — `api.sh` already captures those in `api-logs/`.

## Notes

- If `/workspace/extra/` repos are not mounted, note this in the analysis and provide what you can from the Jira ticket alone.
- Use `/workspace/scripts/atlassian-api.sh` for all API calls — never raw curl.
