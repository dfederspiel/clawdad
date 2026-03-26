# Agent Gaps & Next Steps

Captured 2026-03-20. Review and update as items are completed.

## Deployment Agent (`discord_deployments`)

- [x] **Universal API wrapper (`api.sh`)** — logs all requests, captures errors, timing, curl stderr, consecutive failure detection
- [x] **Pre-deployment version check (`/version-check` skill)** — compares GitHub/GitLab/GAR versions before any Harness trigger
- [x] **Mandatory failure investigation policy** — agent must auto-drill into logs, not guess at causes
- [x] **Default deployment order** — defaults to `devCentralMainApp`, not IM. Spot pipelines only when user names a specific env
- [x] **Black Duck version accuracy** — always search for exact version, never fall back to different version
- [x] **Stale data rule** — always re-query live APIs when asked for status
- [x] **Connectivity failure alerting** — consecutive failure counter with escalation rules (stop after 3+, report to user)
- [x] **Webb deployment monitoring API** — discovered and documented `/api/runs`, `/api/tests`, `/api/products` endpoints with full field reference
- [x] **Proactive BD Hub vuln check** — agent checks Black Duck Hub immediately after `new_pop_blackduck` completes, before Harness starts
- [x] **Proactive Webb test monitoring** — agent polls Webb during Harness cdev stage for early failure detection (~5-10 min earlier than waiting for Harness)
- [ ] **Migrate `/deploy-status` and `/check-flag` to use `api.sh` wrapper** — both skills still use raw `curl`. Errors from these won't appear in `/api-errors` logs.
- [ ] **Black Duck vulnerability remediation APIs** — learn the BD API for marking vulns as "Known not affected" programmatically. Currently manual. User feedback: "The APIs should allow us to collect this information as well."
- [ ] **Kong dev portal GitHub source details** — versioning chain for Kong is less documented than polaris-ui. Needed for accurate `/version-check` verdicts.
- [ ] **Liquibase vs non-Liquibase services** — undocumented which services need DB migrations. Matters when deploying from the "Other Projects" list via generic pipelines.
- [ ] **Notification preferences** — no rules for when the agent should proactively ping vs silently log. Suggestion: ping for failures and approvals, log-only for successful stage completions.

## Updates Agent (`discord_updates`)

- [x] **Agent created** — CLAUDE.md with daily/weekly workflow, interaction logging, Jira/Confluence access
- [ ] **Test end-to-end** — agent has instructions but hasn't been exercised. First real interaction will surface gaps in interaction logging, daily synthesis, and Jira query accuracy.
- [ ] **Set up daily check-in scheduled task** — CLAUDE.md mentions "when prompted by a scheduled task" but no task exists yet. Use `schedule_task` for an end-of-day nudge.
- [ ] **Add sprint context** — jira-ticket skill has sprint lookup, but updates agent doesn't know how to query current sprint for "what's in this sprint" questions.

## Cross-Cutting

- [x] **`/api-errors` analysis improvements** — pattern detection for connectivity outages, auth failures, rate limiting, repeated same-path errors, slow services
- [ ] **Create `groups/global/CLAUDE.md`** — shared context (API wrapper usage, Atlassian access, team info) that all non-main groups inherit. Currently each group re-documents this independently.

## Suggested Priority (Monday)

| # | Item | Effort |
|---|------|--------|
| 1 | Test the updates agent with a real daily check-in | 15 min |
| 2 | Migrate `/deploy-status` and `/check-flag` to use `api.sh` | 15 min |
| 3 | Set up daily check-in scheduled task for updates agent | 10 min |
| 4 | Create `groups/global/CLAUDE.md` with shared context | 20 min |
| 5 | Define notification preferences for deployment agent | 10 min |
| 6 | Explore BD vulnerability remediation APIs | 30 min |

Lower priority items (Kong source, Liquibase, sprint context) can be filled in as those situations come up.
