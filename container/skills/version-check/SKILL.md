---
name: version-check
description: Pre-deployment version comparison across GitHub/GitLab/Harness GAR. MANDATORY before any deployment trigger. Catches version mismatches and premature pipeline runs.
---

# /version-check — Pre-Deployment Version Verification

**Run this BEFORE triggering any Harness deployment.** Compares source-of-truth versions against what's actually been built and published to GAR.

## Usage

`/version-check` — check both services
`/version-check polaris-ui` — polaris-ui only
`/version-check kong` — kong dev portal only

## Polaris UI Version Chain

Source of truth: **GitHub release tags** → GitLab builds from those tags → Harness deploys from GAR.

Failure mode: GitLab pipeline runs before GitHub Actions creates the tag → builds stale version.

### Step 1: GitHub — Latest Release Tag

```bash
echo "=== POLARIS UI VERSION CHECK ==="
echo ""
echo "--- GitHub (source of truth) ---"
GH_RELEASE=$(GH_TOKEN=$GITHUB_TOKEN gh release list -R Synopsys-SIG-RnD/polaris-ui -L 1 --json tagName,publishedAt,isLatest 2>/dev/null)
GH_VERSION=$(echo "$GH_RELEASE" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['tagName'] if r else 'NONE')" 2>/dev/null || echo "NONE")
GH_DATE=$(echo "$GH_RELEASE" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['publishedAt'][:19] if r else '?')" 2>/dev/null || echo "?")
echo "  Latest release: $GH_VERSION ($GH_DATE)"
# Strip leading 'v' for comparison
GH_VERSION_BARE=$(echo "$GH_VERSION" | sed 's/^v//')
```

### Step 2: GitLab — What Version Did the Last Pipeline Build?

```bash
echo ""
echo "--- GitLab Pipeline (project 9634) ---"
# Get the latest successful pipeline
PIPELINE_JSON=$(/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/9634/pipelines?ref=main&status=success&per_page=1" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" 2>/dev/null)

PIPELINE_ID=$(echo "$PIPELINE_JSON" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p[0]['id'] if p else 'NONE')" 2>/dev/null || echo "NONE")
PIPELINE_DATE=$(echo "$PIPELINE_JSON" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p[0]['created_at'][:19] if p else '?')" 2>/dev/null || echo "?")

if [ "$PIPELINE_ID" != "NONE" ]; then
  echo "  Latest successful pipeline: #$PIPELINE_ID ($PIPELINE_DATE)"

  # Find the version job to extract what version was built
  JOBS_JSON=$(/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/9634/pipelines/$PIPELINE_ID/jobs" \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" 2>/dev/null)

  VERSION_JOB_ID=$(echo "$JOBS_JSON" | python3 -c "
import sys, json
jobs = json.load(sys.stdin)
for j in jobs:
    if j.get('name') == 'version':
        print(j['id'])
        break
else:
    print('NONE')
" 2>/dev/null || echo "NONE")

  if [ "$VERSION_JOB_ID" != "NONE" ]; then
    VERSION_LOG=$(/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/9634/jobs/$VERSION_JOB_ID/trace" \
      -H "PRIVATE-TOKEN: $GITLAB_TOKEN" 2>/dev/null)
    GL_VERSION=$(echo "$VERSION_LOG" | grep -oP '(?<=Version:\s)[\d.]+' | head -1 || echo "")
    if [ -z "$GL_VERSION" ]; then
      GL_VERSION=$(echo "$VERSION_LOG" | grep -oP 'TAG_NAME[=: ]+v?([\d.]+)' | head -1 | grep -oP '[\d.]+' || echo "UNKNOWN")
    fi
    echo "  Built version: $GL_VERSION"
  else
    GL_VERSION="UNKNOWN"
    echo "  Version job not found in pipeline #$PIPELINE_ID"
  fi
else
  GL_VERSION="UNKNOWN"
  echo "  No successful pipelines found"
fi
```

### Step 3: Harness GAR — What Versions Are Available to Deploy?

```bash
echo ""
echo "--- Harness GAR (deployable artifacts) ---"
GAR_JSON=$(/workspace/scripts/api.sh harness GET \
  "https://app.harness.io/ng/api/artifacts/gar/getBuildDetails?accountIdentifier=$HARNESS_ACCOUNT_ID&orgIdentifier=polaris&projectIdentifier=enterprise_governance&connectorRef=org.PolarisGar&region=us&repositoryName=polarisng-charts&project=cloudops-artifacts-prd&package=altair-main-app" \
  -H "x-api-key: $HARNESS_API_KEY" 2>/dev/null)

GAR_LATEST=$(echo "$GAR_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
builds = data.get('data', {}).get('buildDetailsList', [])
if builds:
    print(builds[0].get('version', 'NONE'))
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
echo "  Latest in GAR: $GAR_LATEST"
```

### Step 4: Verdict

```bash
echo ""
echo "=== VERDICT ==="

# Compare GitHub vs GitLab
if [ "$GH_VERSION_BARE" = "$GL_VERSION" ]; then
  echo "  GitHub <> GitLab: MATCH ($GH_VERSION_BARE)"
elif [ "$GL_VERSION" = "UNKNOWN" ]; then
  echo "  GitHub <> GitLab: UNKNOWN (could not extract GitLab build version)"
else
  echo "  GitHub <> GitLab: MISMATCH — GitHub has $GH_VERSION_BARE, GitLab built $GL_VERSION"
  echo "  WARNING: GitLab may have run before the GitHub tag was created"
fi

# Compare GitLab vs GAR
if echo "$GAR_LATEST" | grep -q "$GL_VERSION"; then
  echo "  GitLab <> GAR: MATCH ($GL_VERSION available in GAR)"
elif [ "$GL_VERSION" = "UNKNOWN" ] || [ "$GAR_LATEST" = "NONE" ]; then
  echo "  GitLab <> GAR: UNKNOWN (missing data)"
else
  echo "  GitLab <> GAR: MISMATCH — GitLab built $GL_VERSION, GAR latest is $GAR_LATEST"
  echo "  WARNING: Build may not have published yet, or helm_chart stage failed"
fi

# Compare GitHub vs GAR (end-to-end)
if echo "$GAR_LATEST" | grep -q "$GH_VERSION_BARE"; then
  echo "  GitHub <> GAR: MATCH — $GH_VERSION is deployable"
  echo ""
  echo "  SAFE TO DEPLOY $GH_VERSION"
else
  echo "  GitHub <> GAR: MISMATCH — GitHub has $GH_VERSION, GAR has $GAR_LATEST"
  echo ""
  echo "  DO NOT DEPLOY — version not yet available in GAR"
  echo "  -> Check if GitLab pipeline needs to run or is still in progress"
fi
```

---

## Kong Dev Portal Version Chain

Source of truth: **GitLab tags** (project 7087) → GitLab builds helm chart → Harness auto-triggers on publish.

### Step 1: GitLab — Latest Tag

```bash
echo ""
echo "=== KONG DEV PORTAL VERSION CHECK ==="
echo ""
echo "--- GitLab Tags (source of truth, project 7087) ---"
KDP_TAGS=$(/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/7087/repository/tags?per_page=3" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" 2>/dev/null)

KDP_LATEST_TAG=$(echo "$KDP_TAGS" | python3 -c "
import sys, json
tags = json.load(sys.stdin)
if tags:
    print(tags[0]['name'])
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
echo "  Latest tag: $KDP_LATEST_TAG"
```

### Step 2: GitLab — Pipeline Status for That Tag

```bash
echo ""
echo "--- GitLab Pipeline (project 7087) ---"
KDP_PIPELINE=$(/workspace/scripts/api.sh gitlab GET "$GITLAB_URL/api/v4/projects/7087/pipelines?per_page=3&status=success" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" 2>/dev/null)

echo "$KDP_PIPELINE" | python3 -c "
import sys, json
pipelines = json.load(sys.stdin)
for p in pipelines[:3]:
    print(f\"  #{p['id']} -- {p['status']} (ref: {p['ref']}, {p['created_at'][:19]})\")
" 2>/dev/null || echo "  Could not fetch pipelines"
```

### Step 3: Harness GAR — Available Versions

```bash
echo ""
echo "--- Harness GAR (deployable artifacts) ---"
KDP_GAR=$(/workspace/scripts/api.sh harness GET \
  "https://app.harness.io/ng/api/artifacts/gar/getBuildDetails?accountIdentifier=$HARNESS_ACCOUNT_ID&orgIdentifier=polaris&projectIdentifier=enterprise_governance&connectorRef=org.PolarisGar&region=us&repositoryName=polarisng-charts&project=cloudops-artifacts-prd&package=altair-kong-dev-portal" \
  -H "x-api-key: $HARNESS_API_KEY" 2>/dev/null)

KDP_GAR_LATEST=$(echo "$KDP_GAR" | python3 -c "
import sys, json
data = json.load(sys.stdin)
builds = data.get('data', {}).get('buildDetailsList', [])
if builds:
    print(builds[0].get('version', 'NONE'))
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
echo "  Latest in GAR: $KDP_GAR_LATEST"
```

### Step 4: Verdict

```bash
echo ""
echo "=== VERDICT ==="
if echo "$KDP_GAR_LATEST" | grep -q "$KDP_LATEST_TAG"; then
  echo "  GitLab tag <> GAR: MATCH — $KDP_LATEST_TAG is deployable"
  echo ""
  echo "  SAFE TO DEPLOY $KDP_LATEST_TAG"
  echo "  (Note: Harness auto-triggers on helm chart publish — check for running execution first)"
else
  echo "  GitLab tag <> GAR: MISMATCH — tag is $KDP_LATEST_TAG, GAR has $KDP_GAR_LATEST"
  echo ""
  echo "  DO NOT DEPLOY — version not yet available in GAR"
  echo "  -> GitLab pipeline may still be building, or helm chart publish failed"
fi
```

## Common Issues

| Symptom | Cause | Resolution |
|---------|-------|------------|
| GitHub has v2.452.0 but GitLab built 2.451.3 | GitLab pipeline ran before GitHub Actions created the tag | Wait for next scheduled sync (11:00 UTC) or manually trigger GitLab pipeline |
| GitLab succeeded but version not in GAR | `helm_chart` publishing stage failed silently | Check the publishing stage log in GitLab |
| GAR has the version but Harness says "version not found" | GAR cache lag | Wait 1-2 minutes, retry the GAR query |
| Kong tag exists but GAR version doesn't match format | Kong uses `{major}.{minor}.{patch}-{timestamp}` not just the tag | Check GAR list for versions starting with the tag prefix |

## After Checking

- If **SAFE**: Proceed with deployment (security check, then Harness trigger)
- If **MISMATCH**: Report the gap, suggest waiting or triggering the GitLab pipeline
- If **UNKNOWN**: Dig into the specific step that failed and report findings
