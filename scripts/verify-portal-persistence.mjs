#!/usr/bin/env node
// Verify panel persistence: open a portal, reload, confirm it's still in the stack.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3456';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.setItem('clawdad-selected-jid', 'web:deep-dive'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Clear any lingering panel state so we start clean
await page.evaluate(() => localStorage.removeItem('clawdad-portal-panel-state'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

console.log('STEP 1: fire a portal action');
await page.evaluate(() => fetch('/api/action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jid: 'web:deep-dive',
    target_agent: 'writer',
    label: 'Persistence test',
    action_message: 'Reply with exactly three sentences about crickets. Short.',
  }),
}));

// Wait for portal section to appear
await page.waitForSelector('section', { timeout: 20_000 });
await page.waitForTimeout(10_000); // give the delegation time to finish

const afterOpen = await page.evaluate(() => ({
  panelState: localStorage.getItem('clawdad-portal-panel-state'),
  drawerPresent: !!document.querySelector('aside .portal-scroll'),
  sectionCount: document.querySelectorAll('section').length,
  agentPanelMode: (() => {
    // Probe the mode by looking at the drawer header text
    const h = document.querySelector('aside h3');
    return h?.textContent?.trim();
  })(),
}));
console.log('after open:', JSON.stringify(afterOpen, null, 2));

console.log('\nSTEP 2: reload page');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const afterReload = await page.evaluate(() => ({
  panelStateAfter: localStorage.getItem('clawdad-portal-panel-state'),
  drawerPresent: !!document.querySelector('aside .portal-scroll'),
  sectionCount: document.querySelectorAll('section').length,
  header: document.querySelector('aside h3')?.textContent?.trim(),
}));
console.log('after reload:', JSON.stringify(afterReload, null, 2));

const pass = afterReload.drawerPresent && afterReload.sectionCount >= 1;
console.log('\nRESULT:', pass ? 'PASS ✓' : 'FAIL ✗');
await browser.close();
process.exit(pass ? 0 : 1);
