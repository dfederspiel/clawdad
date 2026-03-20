---
name: api-errors
description: Review API error logs across all services (Atlassian, GitLab, Harness, Black Duck, LaunchDarkly, Webb). Shows failed requests with status codes, endpoints, error messages, and timing. Detects patterns like connectivity outages, auth failures, and rate limiting.
---

# /api-errors — API Error Report

Analyze API error logs and produce an actionable summary. Covers all services.

## How to Run

```bash
echo "=== Error Logs ==="
for f in /workspace/group/api-logs/*-errors.jsonl; do
  [ -f "$f" ] || continue
  SERVICE=$(basename "$f" | sed 's/-errors.jsonl//')
  COUNT=$(wc -l < "$f")
  echo ""
  echo "--- $SERVICE ($COUNT errors) ---"
  cat "$f"
done 2>/dev/null || echo "No errors logged yet."

echo ""
echo "=== Analysis ==="
if [ -f /workspace/group/api-logs/all-requests.jsonl ]; then
  python3 << 'PYEOF'
import json, sys
from collections import Counter, defaultdict

services = Counter()
errors = Counter()
status_codes = Counter()
durations = defaultdict(list)
error_runs = defaultdict(list)  # track consecutive failure windows
hosts = {}

# --- Pass 1: Parse all requests ---
entries = []
with open("/workspace/group/api-logs/all-requests.jsonl") as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            entries.append(json.loads(line))
        except: pass

for entry in entries:
    svc = entry.get("service", "unknown")
    services[svc] += 1
    status = entry.get("status", "?")
    status_codes[f"{svc}:{status}"] += 1
    ok = entry.get("ok", True)
    if not ok:
        errors[svc] += 1
    dur = entry.get("duration_ms", 0)
    if dur:
        durations[svc].append(dur)
    host = entry.get("host", "")
    if host:
        hosts[svc] = host

total = sum(services.values())
total_err = sum(errors.values())
rate = (total_err / total * 100) if total > 0 else 0

print(f"Total requests: {total} ({total_err} errors, {rate:.1f}% failure rate)")
print()

# --- Per-service summary ---
for svc, count in services.most_common():
    err = errors.get(svc, 0)
    err_rate = (err / count * 100) if count > 0 else 0
    host = hosts.get(svc, "?")
    dur_list = durations.get(svc, [])
    avg_ms = int(sum(dur_list) / len(dur_list)) if dur_list else 0
    max_ms = max(dur_list) if dur_list else 0

    status_parts = []
    for key, cnt in status_codes.most_common():
        if key.startswith(f"{svc}:"):
            code = key.split(":")[1]
            status_parts.append(f"{code}x{cnt}")

    print(f"  {svc} ({host}): {count} requests, {err} errors ({err_rate:.0f}%)")
    if dur_list:
        print(f"    Timing: avg {avg_ms}ms, max {max_ms}ms")
    print(f"    Status codes: {', '.join(status_parts)}")
    print()

# --- Pattern detection ---
print("=== Patterns Detected ===")
print()
patterns_found = False

# Detect connectivity outage windows (consecutive 000s)
for svc in set(e.get("service", "") for e in entries):
    run_start = None
    run_count = 0
    svc_entries = [e for e in entries if e.get("service") == svc]
    for e in svc_entries:
        if e.get("status") == 0 or str(e.get("status")) == "0" or str(e.get("status")) == "000":
            if run_start is None:
                run_start = e.get("ts", "?")
            run_count += 1
        else:
            if run_count >= 3:
                print(f"  CONNECTIVITY OUTAGE: {svc} had {run_count} consecutive connection failures")
                print(f"    Window: {run_start} to {e.get('ts', '?')}")
                print(f"    Host: {hosts.get(svc, '?')}")
                print(f"    Action: Check VPN, DNS, or host reachability")
                print()
                patterns_found = True
            run_start = None
            run_count = 0
    # Check trailing run
    if run_count >= 3:
        last_ts = svc_entries[-1].get("ts", "?") if svc_entries else "?"
        print(f"  CONNECTIVITY OUTAGE: {svc} has {run_count} consecutive failures (ONGOING)")
        print(f"    Since: {run_start}")
        print(f"    Host: {hosts.get(svc, '?')}")
        print(f"    Action: Check VPN, DNS, or host reachability NOW")
        print()
        patterns_found = True

# Detect auth failures
for svc in set(e.get("service", "") for e in entries):
    auth_errors = [e for e in entries if e.get("service") == svc and e.get("status") in (401, 403, "401", "403")]
    if len(auth_errors) >= 2:
        print(f"  AUTH FAILURE: {svc} has {len(auth_errors)} auth errors (401/403)")
        print(f"    Host: {hosts.get(svc, '?')}")
        print(f"    Action: Token may be expired or missing permissions")
        print()
        patterns_found = True

# Detect rate limiting
for svc in set(e.get("service", "") for e in entries):
    rate_errors = [e for e in entries if e.get("service") == svc and str(e.get("status")) == "429"]
    if rate_errors:
        print(f"  RATE LIMITED: {svc} hit 429 x{len(rate_errors)}")
        print(f"    Action: Add delays between requests or reduce polling frequency")
        print()
        patterns_found = True

# Detect repeated same-path failures (likely a bug in skill/CLAUDE.md)
path_errors = defaultdict(int)
for e in entries:
    if not e.get("ok", True):
        key = f"{e.get('service', '?')}:{e.get('method', '?')} {e.get('path', '?')}"
        path_errors[key] += 1
for path, count in sorted(path_errors.items(), key=lambda x: -x[1]):
    if count >= 3:
        print(f"  REPEATED FAILURE: {path} failed {count} times")
        print(f"    Action: Check if the endpoint/path is correct in CLAUDE.md or skill")
        print()
        patterns_found = True

# Detect slow requests (>10s average)
for svc, dur_list in durations.items():
    if dur_list:
        avg = sum(dur_list) / len(dur_list)
        if avg > 10000:
            print(f"  SLOW SERVICE: {svc} averaging {int(avg)}ms per request")
            print(f"    Action: May be timing out; consider if requests are too large")
            print()
            patterns_found = True

if not patterns_found:
    print("  No concerning patterns detected.")

PYEOF
else
  echo "No requests logged yet."
fi
```

## Per-Service Error Files

| Service | Error Log | Tracked By |
|---------|-----------|------------|
| `atlassian` | `atlassian-errors.jsonl` | `atlassian-api.sh` or `api.sh atlassian` |
| `gitlab` | `gitlab-errors.jsonl` | `api.sh gitlab` |
| `harness` | `harness-errors.jsonl` | `api.sh harness` |
| `blackduck` | `blackduck-errors.jsonl` | `api.sh blackduck` |
| `launchdarkly` | `launchdarkly-errors.jsonl` | `api.sh launchdarkly` |
| `webb` | `webb-errors.jsonl` | `api.sh webb` |
| `github` | (not yet tracked — uses `gh` CLI) | — |

## Log Format

Each error entry now includes:
```json
{
  "ts": "2026-03-20T21:47:51Z",
  "service": "gitlab",
  "method": "GET",
  "host": "gitlab.tools.duckutil.net",
  "path": "/api/v4/projects/9634/pipelines/2665705",
  "status": 0,
  "ok": false,
  "duration_ms": 15023,
  "error": "Could not resolve host: gitlab.tools.duckutil.net"
}
```

Each request summary includes:
```json
{
  "ts": "...",
  "service": "gitlab",
  "method": "GET",
  "host": "gitlab.tools.duckutil.net",
  "path": "/api/v4/...",
  "status": 200,
  "ok": true,
  "bytes": 31009,
  "duration_ms": 342
}
```

## What to Look For

- **000 errors**: Connection/DNS failure. No HTTP response at all. Check network, VPN, container DNS.
- **400 errors**: Wrong field format or missing required fields. Read the error body for specifics.
- **401 errors**: Token expired or wrong. Flag to user with the env var name.
- **403 errors**: Permission issue. Token may lack access to this resource.
- **404 errors**: Resource doesn't exist. Wrong ID, deleted, or bad API path.
- **429 errors**: Rate limited. Add delays between bulk operations.
- **5xx errors**: Server-side failure. May indicate an outage — check service status.
- **Slow requests (>10s)**: May be hitting timeouts. Check request payload size.
- **Repeated same-path failures**: The endpoint or path is likely wrong in a skill or CLAUDE.md.
- **Consecutive 000s**: Connectivity outage window. Stop retrying and report.

## After Analysis

If you identify a recurring pattern:
1. Describe the root cause clearly
2. Propose the fix (update CLAUDE.md, skill, wrapper, or env config)
3. If it's a connectivity issue, tell the user — don't silently retry
4. If it's a bad endpoint, find where the URL is defined and correct it
