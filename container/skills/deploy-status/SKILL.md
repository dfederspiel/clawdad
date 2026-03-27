---
name: deploy-status
description: Check deployment pipeline status across GitHub, GitLab, and Harness. Use when asked about deployment status, pipeline progress, or "where is the deploy at?" questions.
---

# /deploy-status — Deployment Pipeline Status

Check the end-to-end deployment pipeline status for a service. Deterministic — always query live APIs.

## Usage

`/deploy-status` — status of both services (polaris-ui + kong dev portal)
`/deploy-status polaris-ui` — polaris-ui only
`/deploy-status kong` — kong dev portal only

## Auth

Credentials are injected automatically by the OneCLI gateway. If credential env vars are set (native proxy / legacy), they're passed explicitly as a fallback. Source the helper at the top of your script:

```bash
source /workspace/scripts/auth-args.sh
```

## Step 1: GitHub — Latest Release

```bash
source /workspace/scripts/auth-args.sh
SERVICE="$1"  # "polaris-ui", "kong", or empty for both

if [ -z "$SERVICE" ] || [ "$SERVICE" = "polaris-ui" ]; then
  echo "## Polaris UI"
  echo ""
  echo "### GitHub Release"
  GH_TOKEN=$(github_token) gh release list -R Synopsys-SIG-RnD/polaris-ui -L 3 --json tagName,publishedAt,isLatest \
    | python3 -c "
import sys, json
releases = json.load(sys.stdin)
for r in releases:
    latest = ' ← LATEST' if r.get('isLatest') else ''
    print(f\"  {r['tagName']} ({r['publishedAt'][:10]}){latest}\")
"
  echo ""
fi

if [ -z "$SERVICE" ] || [ "$SERVICE" = "kong" ]; then
  echo "## Kong Dev Portal"
  echo ""
  echo "### GitLab Tags"
  /workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/7087/repository/tags?per_page=3" \
    $(gitlab_auth) | \
    python3 -c "
import sys, json
tags = json.load(sys.stdin)
for t in tags:
    name = t['name']
    date = t.get('commit', {}).get('created_at', '')[:10]
    print(f\"  {name} ({date})\")
"
  echo ""
fi
```

## Step 2: GitLab — Pipeline Status

```bash
if [ -z "$SERVICE" ] || [ "$SERVICE" = "polaris-ui" ]; then
  echo "### GitLab Pipeline (polaris-ui, project 9634)"
  /workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/9634/pipelines?per_page=3" \
    $(gitlab_auth) | \
    python3 -c "
import sys, json
pipelines = json.load(sys.stdin)
for p in pipelines:
    print(f\"  #{p['id']} — {p['status']} (ref: {p['ref']}, {p['created_at'][:16]})\")
    print(f\"    {p['web_url']}\")
"
  echo ""
fi

if [ -z "$SERVICE" ] || [ "$SERVICE" = "kong" ]; then
  echo "### GitLab Pipeline (kong-dev-portal, project 7087)"
  /workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/7087/pipelines?per_page=3" \
    $(gitlab_auth) | \
    python3 -c "
import sys, json
pipelines = json.load(sys.stdin)
for p in pipelines:
    print(f\"  #{p['id']} — {p['status']} (ref: {p['ref']}, {p['created_at'][:16]})\")
    print(f\"    {p['web_url']}\")
"
  echo ""
fi
```

## Step 3: Harness — Active Executions

```bash
if [ -z "$SERVICE" ] || [ "$SERVICE" = "polaris-ui" ]; then
  echo "### Harness Executions (polaris-ui)"
  /workspace/scripts/api.sh harness POST \
    "https://app.harness.io/pipeline/api/pipelines/execution/v2/summary?accountIdentifier=$HARNESS_ACCOUNT_ID&orgIdentifier=polaris&projectIdentifier=enterprise_governance&page=0&size=5" \
    $(harness_auth) \
    -H "Content-Type: application/json" \
    -d '{"filterType":"PipelineExecution","pipelineIdentifiers":["imDomainMainApp","devCentralMainApp","productionAltairMainApp"]}' | \
    python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {}).get('content', [])
if not data:
    print('  No recent executions')
else:
    for e in data:
        s = e.get('pipelineExecutionSummary', e)
        name = s.get('pipelineIdentifier', '?')
        status = s.get('status', '?')
        start = s.get('startTs', 0)
        from datetime import datetime
        dt = datetime.fromtimestamp(start/1000).strftime('%Y-%m-%d %H:%M') if start else '?'
        eid = s.get('planExecutionId', '')
        print(f'  {name} — {status} ({dt})')
        print(f'    https://app.harness.io/ng/account/$HARNESS_ACCOUNT_ID/cd/orgs/polaris/projects/enterprise_governance/pipelines/{name}/executions/{eid}/pipeline')
"
  echo ""
fi

if [ -z "$SERVICE" ] || [ "$SERVICE" = "kong" ]; then
  echo "### Harness Executions (kong-dev-portal)"
  /workspace/scripts/api.sh harness POST \
    "https://app.harness.io/pipeline/api/pipelines/execution/v2/summary?accountIdentifier=$HARNESS_ACCOUNT_ID&orgIdentifier=polaris&projectIdentifier=enterprise_governance&page=0&size=5" \
    $(harness_auth) \
    -H "Content-Type: application/json" \
    -d '{"filterType":"PipelineExecution","pipelineIdentifiers":["productionaltairkongdevportallatest","devCentralKongDevPortal"]}' | \
    python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {}).get('content', [])
if not data:
    print('  No recent executions')
else:
    for e in data:
        s = e.get('pipelineExecutionSummary', e)
        name = s.get('pipelineIdentifier', '?')
        status = s.get('status', '?')
        start = s.get('startTs', 0)
        from datetime import datetime
        dt = datetime.fromtimestamp(start/1000).strftime('%Y-%m-%d %H:%M') if start else '?'
        eid = s.get('planExecutionId', '')
        print(f'  {name} — {status} ({dt})')
        print(f'    https://app.harness.io/ng/account/$HARNESS_ACCOUNT_ID/cd/orgs/polaris/projects/enterprise_governance/pipelines/{name}/executions/{eid}/pipeline')
"
  echo ""
fi
```

## Step 4: Black Duck — Security Gate

```bash
BEARER=$(/workspace/scripts/api.sh blackduck POST "$BLACKDUCK_URL/api/tokens/authenticate" \
  $(blackduck_token_auth) \
  -H "Accept: application/vnd.blackducksoftware.user-4+json" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['bearerToken'])")

if [ -z "$SERVICE" ] || [ "$SERVICE" = "polaris-ui" ]; then
  echo "### Black Duck (polaris-ui)"
  VERSION_JSON=$(/workspace/scripts/api.sh blackduck GET \
    "$BLACKDUCK_URL/api/projects/ae23af31-0d1f-4da9-82a9-e7182933a083/versions?limit=1&sort=releasedon%20desc" \
    -H "Authorization: Bearer $BEARER" \
    -H "Accept: application/vnd.blackducksoftware.project-detail-5+json")
  VERSION_HREF=$(echo "$VERSION_JSON" | python3 -c "import sys,json; v=json.load(sys.stdin)['items'][0]; print(v['versionName']); print(v['_meta']['href'])" 2>/dev/null)
  VERSION_NAME=$(echo "$VERSION_HREF" | head -1)
  HREF=$(echo "$VERSION_HREF" | tail -1)
  echo "  Latest: $VERSION_NAME"
  POLICY=$(/workspace/scripts/api.sh blackduck GET "${HREF}/policy-status" \
    -H "Authorization: Bearer $BEARER" \
    -H "Accept: application/vnd.blackducksoftware.bill-of-materials-6+json" 2>/dev/null) && \
    echo "$POLICY" | python3 -c "
import sys,json
ps=json.load(sys.stdin)
status=ps.get('overallStatus','?')
emoji='✅' if status=='NOT_IN_VIOLATION' else '🚫'
print(f'  Policy: {emoji} {status}')
" || echo "  Policy: could not fetch"
  echo ""
fi

if [ -z "$SERVICE" ] || [ "$SERVICE" = "kong" ]; then
  echo "### Black Duck (kong-dev-portal)"
  VERSION_JSON=$(/workspace/scripts/api.sh blackduck GET \
    "$BLACKDUCK_URL/api/projects/1d0ea9ea-491a-4014-b234-fbe43aa0fabc/versions?limit=1&sort=releasedon%20desc" \
    -H "Authorization: Bearer $BEARER" \
    -H "Accept: application/vnd.blackducksoftware.project-detail-5+json")
  VERSION_HREF=$(echo "$VERSION_JSON" | python3 -c "import sys,json; v=json.load(sys.stdin)['items'][0]; print(v['versionName']); print(v['_meta']['href'])" 2>/dev/null)
  VERSION_NAME=$(echo "$VERSION_HREF" | head -1)
  HREF=$(echo "$VERSION_HREF" | tail -1)
  echo "  Latest: $VERSION_NAME"
  POLICY=$(/workspace/scripts/api.sh blackduck GET "${HREF}/policy-status" \
    -H "Authorization: Bearer $BEARER" \
    -H "Accept: application/vnd.blackducksoftware.bill-of-materials-6+json" 2>/dev/null) && \
    echo "$POLICY" | python3 -c "
import sys,json
ps=json.load(sys.stdin)
status=ps.get('overallStatus','?')
emoji='✅' if status=='NOT_IN_VIOLATION' else '🚫'
print(f'  Policy: {emoji} {status}')
" || echo "  Policy: could not fetch"
  echo ""
fi
```

## Step 5: Harness Gate Readiness (all-services.json)

Check the GCS file that Harness actually reads for deployment gate decisions:

```bash
echo "### Harness Gate Readiness (all-services.json)"
/workspace/scripts/api.sh harness GET \
  "https://storage.googleapis.com/test-altair-dev/all-services.json" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
ts = data.get('generation_timestamp', '?')
print(f'  Generated: {ts}')
print()
for svc in ['altair-main-app', 'kong-dev-portal']:
    label = 'Polaris UI' if 'main-app' in svc else 'Kong Dev Portal'
    versions = data.get('versions', {}).get(svc, [])
    if not versions:
        print(f'  {label}: no versions in gate file')
        continue
    for v in versions[:2]:
        emoji = '✅' if v.get('deployable') else '🚫'
        print(f'  {emoji} {label} {v[\"version\"]}: deployable={v[\"deployable\"]}')
        if not v.get('deployable'):
            msg = v.get('deployable_message', 'unknown')[:200]
            print(f'     Reason: {msg}')
print()
"
```

This is the source of truth for Harness service-check gates — NOT BD Hub directly. If BD Hub shows green but this shows red, the dashboard update hasn't propagated yet (~10 min delay).

## Notes

- Always query live APIs — never report status from memory
- Kong dev portal's Harness pipeline auto-triggers on GitLab helm chart publish — do NOT manually trigger unless explicitly asked
- When reporting, include clickable links to GitLab pipelines and Harness executions
- If a pipeline is at an approval gate, mention it prominently
- If `all-services.json` shows `deployable: false`, warn the user BEFORE triggering or approving — the gate WILL block
