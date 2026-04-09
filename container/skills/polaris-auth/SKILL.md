---
name: polaris-auth
description: Authenticate to Polaris environments (CDEV, CO, IM, STG, etc.) using pre-established session cookies or API tokens. The host keeps sessions alive automatically. Use whenever you need to call any Polaris API.
---

# Polaris Authentication — Pre-Established Sessions & API Tokens

The host maintains authenticated sessions to Polaris environments via Playwright browser-based Keycloak login and 5-minute keepalive pings. It also generates long-lived API tokens per environment. Both are available in your container.

## Two Auth Methods

| Method | When to use | Header / flag |
|--------|------------|---------------|
| **API token** | Preferred for all API calls — stable, long-lived | `-H "Api-Token: $POLARIS_API_TOKEN"` (**NO** `organization-id` header) |
| **Session cookies** | Fallback when no API token, or for admin-only endpoints | `-b "$POLARIS_COOKIES"` + `-H "organization-id: $POLARIS_ORG_ID"` |

**Critical:** API token auth and `organization-id` header are **mutually exclusive**. Including `organization-id` with an `Api-Token` header causes a 401. The `polaris_api` function handles this automatically.

**Prefer API tokens** — they survive session expiry and don't depend on the keepalive cycle. Use session cookies only for endpoints that require them (e.g., token management endpoints themselves).

## Quick Start — Session Cookies

```bash
# Load session for an environment (e.g., cdev, co, im, stg)
source /workspace/scripts/polaris-auth.sh cdev

# Make API calls using the convenience function
polaris_api GET /api/auth/openid-connect/userinfo
polaris_api GET /api/portfolios/

# Or use curl directly with the exported variables
curl -b "$POLARIS_COOKIES" \
  -H "organization-id: $POLARIS_ORG_ID" \
  -H "x-client-source: polaris-ui" \
  "$POLARIS_BASE_URL/api/portfolios/"
```

## Quick Start — API Token (via Credential Proxy)

API tokens are cached in `.env` as `POLARIS_{ENV}_API_TOKEN` and forwarded through the credential proxy. Use `api.sh` with the placeholder:

```bash
# Load session first (for base URL)
source /workspace/scripts/polaris-auth.sh cdev

# Use api.sh with API token — NO organization-id header!
/workspace/scripts/api.sh polaris-cdev GET \
  "$POLARIS_BASE_URL/api/auth/openid-connect/userinfo" \
  -H "Api-Token: $POLARIS_API_TOKEN"

# Or for CO environment
source /workspace/scripts/polaris-auth.sh co
/workspace/scripts/api.sh polaris-co GET \
  "$POLARIS_BASE_URL/api/portfolios/" \
  -H "Api-Token: $POLARIS_API_TOKEN" \
  -H "Accept: application/vnd.polaris.portfolios-1+json"
```

**Important:** Do NOT include `-H "organization-id: ..."` when using `Api-Token`. The two are mutually exclusive — combining them causes a 401.

## Available Environments

List what's available:

```bash
source /workspace/scripts/polaris-auth.sh --list
```

This shows all environments with active sessions and their base URLs.

## Exported Variables

After sourcing `polaris-auth.sh <env>`, these are set:

| Variable | Content |
|----------|---------|
| `$POLARIS_COOKIES` | Cookie string for `curl -b` (includes `session` and `OrgId` cookies) |
| `$POLARIS_BASE_URL` | Base URL (e.g., `https://cdev.dev.polaris.blackduck.com`) |
| `$POLARIS_ENV` | Environment name (e.g., `cdev`) |
| `$POLARIS_ORG_ID` | Organization ID (required header for all API calls) |
| `$POLARIS_API_TOKEN` | API token for the environment (long-lived, preferred for most calls) |

## `polaris_api` Function

The sourced script provides `polaris_api()` — a wrapper that automatically includes session cookies, organization-id header, and routes through `api.sh` (credential proxy):

```bash
polaris_api <METHOD> <API_PATH> [extra curl args...]
```

**Note:** `polaris_api` uses session cookies by default. To use the API token instead, call `api.sh` directly with the `Api-Token` header (see Quick Start above).

Examples:

```bash
# Get current user info
polaris_api GET /api/auth/openid-connect/userinfo

# List portfolios
polaris_api GET /api/portfolios/

# Get portfolio dashboard
polaris_api GET "/api/portfolios/portfolios/PORTFOLIO_ID/dashboard?_limit=25" \
  -H "Content-Type: application/vnd.pm.portfolio-dashboard-1+json"

# Get user details
polaris_api GET /api/auth/users/USER_ID \
  -H "Accept: application/vnd.polaris.auth.user-1+json"

# Search issues (POST)
polaris_api POST /api/query/v1/issues/_search \
  -H "Content-Type: application/json" \
  -d '{"filter": {"projectId": ["PROJECT_ID"]}, "limit": 20}'
```

## Important: Vendor Content Types

Many Polaris API endpoints require **vendor-specific content types** in the `Accept` and/or `Content-Type` headers. Using `application/json` alone will return the SPA HTML shell instead of API data. Common patterns:

| Endpoint | Content-Type |
|----------|-------------|
| `/api/portfolios/` | `application/vnd.polaris.portfolios-1+json` |
| `/api/portfolios/.../dashboard` | `application/vnd.pm.portfolio-dashboard-1+json` |
| `/api/auth/users/{id}` | `application/vnd.polaris.auth.user-1+json` |
| `/api/auth/offline/api-tokens` | `application/vnd.polaris.auth.api-token-1+json` |
| `/api/entitlement-service/...` | `application/vnd.synopsys.ses.entitlement-3+json` |
| `/api/auth/openid-connect/userinfo` | `application/json` (standard) |

When in doubt, check the SPA's network requests to find the correct content type.

## Important: Organization ID Header

**Session cookie auth requires the `organization-id` header.** Without it, session cookie calls return 401.

```bash
# Session cookie auth — org-id REQUIRED
curl -b "$POLARIS_COOKIES" -H "organization-id: $POLARIS_ORG_ID" "$POLARIS_BASE_URL/api/..."

# API token auth — org-id MUST NOT be included (causes 401)
curl -H "Api-Token: $POLARIS_API_TOKEN" "$POLARIS_BASE_URL/api/..."
```

The `polaris_api` function handles this automatically — it uses API token (no org-id) when available, falling back to cookies (with org-id).

## Working with Multiple Environments

You can switch environments by re-sourcing:

```bash
source /workspace/scripts/polaris-auth.sh cdev
polaris_api GET /api/auth/openid-connect/userinfo   # hits CDEV

source /workspace/scripts/polaris-auth.sh co
polaris_api GET /api/auth/openid-connect/userinfo   # hits CO
```

Or save variables per-environment:

```bash
source /workspace/scripts/polaris-auth.sh cdev
CDEV_URL="$POLARIS_BASE_URL"
CDEV_COOKIES="$POLARIS_COOKIES"
CDEV_ORG="$POLARIS_ORG_ID"
CDEV_TOKEN="$POLARIS_API_TOKEN"

source /workspace/scripts/polaris-auth.sh co
CO_URL="$POLARIS_BASE_URL"
CO_COOKIES="$POLARIS_COOKIES"
CO_ORG="$POLARIS_ORG_ID"
CO_TOKEN="$POLARIS_API_TOKEN"

# Now use either with api.sh
/workspace/scripts/api.sh polaris-cdev GET "$CDEV_URL/api/auth/openid-connect/userinfo" \
  -H "Api-Token: $CDEV_TOKEN" -H "organization-id: $CDEV_ORG"
/workspace/scripts/api.sh polaris-co GET "$CO_URL/api/auth/openid-connect/userinfo" \
  -H "Api-Token: $CO_TOKEN" -H "organization-id: $CO_ORG"
```

## How It Works

1. The host reads `POLARIS_{ENV}_BASE_URL`, `_EMAIL`, and `_PASSWORD` from `.env`
2. On startup, it authenticates each environment using a headless Chromium browser (Playwright)
3. The browser walks through: Polaris sign-in → Keycloak password form → redirect back to app
4. The Kong `session` and `OrgId` cookies are extracted and written to `groups/global/sessions/{env}.json`
5. A long-lived API token is generated and cached in both the session file and `.env` as `POLARIS_{ENV}_API_TOKEN`
6. Every 5 minutes, the keepalive pings the session via `/api/auth/openid-connect/userinfo`
7. If the ping fails (session expired), it re-authenticates via browser and generates a fresh API token
8. Your container mounts `groups/global/` at `/workspace/global/` (read-only)
9. `polaris-auth.sh` reads the session JSON and exports cookies, org ID, base URL, and API token
10. API tokens in `.env` are forwarded through the credential proxy — `api.sh` substitutes placeholders automatically

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No session for environment 'X'" | Environment not configured on host | Ask user to add `POLARIS_X_BASE_URL/EMAIL/PASSWORD` to `.env` |
| Empty `$POLARIS_COOKIES` | Session file unreadable or malformed | Run `--list` to check; host may need restart |
| Empty `$POLARIS_API_TOKEN` | Token not yet generated | Wait for next keepalive cycle (browser re-auth generates tokens) |
| 401/403 with session cookie | Missing `organization-id` header | Add `-H "organization-id: $POLARIS_ORG_ID"` (required for cookie auth) |
| 401/403 with API token | Included `organization-id` header | Remove `-H "organization-id: ..."` — it conflicts with `Api-Token` auth |
| 401/403 with session cookie | Session expired between keepalives | Use `polaris_api` (re-reads fresh cookies), or re-source `polaris-auth.sh` |
| HTML response instead of JSON | Missing vendor content type header | Add the correct `Content-Type`/`Accept` header for the endpoint |
| `polaris_api` fails with "No Polaris session available" | Source step was skipped or failed | Re-run `source /workspace/scripts/polaris-auth.sh <env>` |

## Important Notes

- Sessions are **read-only** from the container — you cannot modify or refresh them yourself
- **API tokens are preferred** over session cookies — they're more stable and survive keepalive gaps
- The keepalive runs every 5 minutes — if a session just expired, it will be restored shortly
- Always use `api.sh` for requests (routes through the credential proxy for logging and credential substitution)
- Do **not** try to authenticate directly via Keycloak from the container
- The `organization-id` header is **required** for all API calls — omitting it causes 401 errors
