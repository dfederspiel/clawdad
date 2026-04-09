#!/usr/bin/env npx tsx
/**
 * Polaris Browser Auth — Playwright-based Keycloak login.
 *
 * Launches a headless Chromium browser, walks through the Polaris
 * sign-in flow (email → password → Keycloak), and extracts the Kong
 * `session` and `OrgId` cookies.  Writes a JSON session file that
 * the keepalive orchestrator and agent containers consume.
 *
 * Usage:
 *   npx tsx scripts/polaris-browser-auth.ts <env-name> [session-file]
 *
 * Reads from .env:
 *   POLARIS_{ENV}_BASE_URL, POLARIS_{ENV}_EMAIL, POLARIS_{ENV}_PASSWORD
 *
 * Exit codes: 0=success, 1=auth failure, 2=env config error
 */
import { chromium, type Cookie } from 'playwright';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ── Args ───────────────────────────────────────────────────────────
const envName = process.argv[2];
if (!envName) {
  console.error(JSON.stringify({
    status: 'error', env: '', action: 'none',
    message: 'Usage: polaris-browser-auth.ts <env-name> [session-file]',
  }));
  process.exit(2);
}
const envUpper = envName.toUpperCase();
const sessionFile = process.argv[3] || `groups/global/sessions/${envName}.json`;

// ── Read .env ──────────────────────────────────────────────────────
function readEnvVar(key: string): string {
  const envPath = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return '';
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === key) {
      let val = trimmed.slice(eq + 1).trim();
      if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return '';
}

const baseUrl = readEnvVar(`POLARIS_${envUpper}_BASE_URL`);
const email = readEnvVar(`POLARIS_${envUpper}_EMAIL`);
const password = readEnvVar(`POLARIS_${envUpper}_PASSWORD`);

if (!baseUrl) {
  console.error(JSON.stringify({
    status: 'error', env: envName, action: 'none',
    message: `POLARIS_${envUpper}_BASE_URL not found in .env`,
  }));
  process.exit(2);
}
if (!email || !password) {
  console.error(JSON.stringify({
    status: 'error', env: envName, action: 'none',
    message: `POLARIS_${envUpper}_EMAIL or POLARIS_${envUpper}_PASSWORD not found in .env`,
  }));
  process.exit(2);
}

const host = baseUrl.replace(/^https?:\/\//, '');

// ── Browser login ──────────────────────────────────────────────────
async function authenticate(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Capture org ID from transient callback URL (e.g., /identity/signin/callback/{org-id})
  let capturedOrgId = '';
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const navUrl = frame.url();
      const match = navUrl.match(/\/identity\/signin\/callback\/([0-9a-f-]{36})/);
      if (match) capturedOrgId = match[1];
    }
  });

  try {
    // Navigate to Polaris — will redirect to sign-in if no session
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    // Wait for the sign-in page
    const url = page.url();
    if (url.includes('/identity/signin') || url.includes('/auth/realms/')) {
      // Step 1: Email entry
      const emailInput = page.getByRole('textbox', { name: 'Email Address' });
      if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailInput.fill(email);
        await page.getByRole('button', { name: 'Next' }).click();
        await page.waitForTimeout(2000);
      }

      // Step 2: Password entry (Keycloak form)
      const passwordInput = page.getByRole('textbox', { name: 'Password' });
      await passwordInput.waitFor({ state: 'visible', timeout: 10_000 });
      await passwordInput.fill(password);
      await page.getByRole('button', { name: 'Sign In' }).click();

      // Wait for redirect back to the app (callback URL or portfolio page)
      await page.waitForURL(url => {
        const s = url.toString();
        return !s.includes('/identity/signin') && !s.includes('/auth/realms/') || s.includes('/callback/');
      }, { timeout: 20_000 });
      // Let the page settle — the SPA may do additional auth steps (POST /api/auth/login)
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Check for auth errors (still on sign-in page, not callback)
    const finalUrl = page.url();
    if ((finalUrl.includes('/identity/signin') && !finalUrl.includes('/callback/')) || finalUrl.includes('/auth/realms/')) {
      console.error(JSON.stringify({
        status: 'error', env: envName, action: 'none',
        message: `Login failed — still on sign-in page: ${finalUrl}`,
      }));
      process.exit(1);
    }

    // Extract cookies
    const cookies = await context.cookies(baseUrl);
    const sessionCookie = cookies.find((c: Cookie) => c.name === 'session');
    const orgIdCookie = cookies.find((c: Cookie) => c.name === 'OrgId');

    if (!sessionCookie) {
      console.error(JSON.stringify({
        status: 'error', env: envName, action: 'none',
        message: 'Login succeeded but no session cookie found',
      }));
      process.exit(1);
    }

    // Get org ID from: cookie > captured callback URL > userinfo endpoint
    let orgId = orgIdCookie?.value || capturedOrgId || '';
    if (!orgId) {
      // Try fetching from userinfo inside the browser (session may only work in-browser)
      try {
        const userinfoResult = await page.evaluate(async () => {
          const r = await fetch('/api/auth/openid-connect/userinfo', {
            headers: { 'Accept': 'application/json' },
          });
          if (r.status === 200) return r.json();
          return null;
        });
        if (userinfoResult?.organization?.id) {
          orgId = userinfoResult.organization.id;
        }
      } catch {
        // Non-fatal
      }
    }
    if (!orgId) {
      // Last resort: try with curl (works for CDEV-style envs)
      try {
        const userinfoOut = execSync([
          'curl', '-s',
          '-b', `session=${sessionCookie.value}`,
          '-H', 'Accept: application/json',
          '--max-time', '10',
          `${baseUrl}/api/auth/openid-connect/userinfo`,
        ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), {
          shell: 'bash', encoding: 'utf-8', timeout: 15_000,
        }).trim();
        const userinfo = JSON.parse(userinfoOut);
        if (userinfo.organization?.id) {
          orgId = userinfo.organization.id;
        }
      } catch {
        // Non-fatal
      }
    }
    const cookieStr = `session=${sessionCookie.value}${orgId ? `; OrgId=${orgId}` : ''}`;

    // ── Generate API token ───────────────────────────────────────
    // Delete any existing clawdad token, then create a fresh one.
    let apiToken = '';
    try {
      // List existing tokens to find and delete old clawdad ones
      const listOut = execSync([
        'curl', '-s',
        '-b', cookieStr,
        '-H', `organization-id: ${orgId}`,
        '-H', 'Accept: application/vnd.polaris.auth.api-token-1+json',
        '-H', 'x-client-source: polaris-ui',
        '--max-time', '10',
        `${baseUrl}/api/auth/offline/api-tokens`,
      ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), {
        shell: 'bash', encoding: 'utf-8', timeout: 15_000,
      }).trim();

      // Delete existing clawdad tokens
      try {
        const existing = JSON.parse(listOut);
        const items = existing._items || existing;
        if (Array.isArray(items)) {
          for (const tok of items) {
            if (tok.name?.startsWith('clawdad-')) {
              execSync([
                'curl', '-s', '-X', 'DELETE',
                '-b', cookieStr,
                '-H', `organization-id: ${orgId}`,
                '-H', 'content-type: application/vnd.polaris.auth.api-token-1+json',
                '--max-time', '10',
                `${baseUrl}/api/auth/offline/api-tokens/${tok.id}`,
              ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), {
                shell: 'bash', encoding: 'utf-8', timeout: 15_000,
              });
            }
          }
        }
      } catch {
        // Listing/deletion failed — not critical, continue
      }

      // Create new token
      const tokenOut = execSync([
        'curl', '-s',
        '-b', cookieStr,
        '-H', `organization-id: ${orgId}`,
        '-H', 'content-type: application/vnd.polaris.auth.api-token-1+json',
        '-H', 'x-client-source: polaris-ui',
        '--max-time', '10',
        '--data-raw', JSON.stringify({ name: `clawdad-${envName}` }),
        `${baseUrl}/api/auth/offline/api-tokens`,
      ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), {
        shell: 'bash', encoding: 'utf-8', timeout: 15_000,
      }).trim();

      const tokenData = JSON.parse(tokenOut);
      if (tokenData.token) {
        apiToken = tokenData.token;
      }
    } catch {
      // Token generation failed — non-fatal, session still works
      console.error(JSON.stringify({
        status: 'warning', env: envName,
        message: 'API token generation failed — session-only auth',
      }));
    }

    // Build session JSON
    const session: Record<string, string> = {
      env: envName,
      base_url: baseUrl,
      domain: host,
      session_cookie: sessionCookie.value,
      org_id: orgId,
      organization_id: orgId,
      updated_at: new Date().toISOString(),
      status: 'active',
    };
    if (apiToken) {
      session.api_token = apiToken;
    }

    // Ensure directory exists and write session file
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Output result on stdout
    console.log(JSON.stringify({
      status: 'ok', env: envName, action: 're-authenticated',
      has_api_token: !!apiToken,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      status: 'error', env: envName, action: 'none',
      message: `Browser auth failed: ${msg}`,
    }));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

authenticate();
