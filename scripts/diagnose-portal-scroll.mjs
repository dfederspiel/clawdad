#!/usr/bin/env node
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3456';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.setItem('clawdad-selected-jid', 'web:deep-dive'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Open an existing historical portal by clicking its pill
const clicked = await page.evaluate(() => {
  const pills = [...document.querySelectorAll('button')].filter((b) =>
    b.textContent?.includes("portal") || b.textContent?.includes('writeup') || b.textContent?.includes('Playwright'),
  );
  if (pills.length === 0) return false;
  pills[pills.length - 1].click(); // most recent
  return true;
});
console.log('pill clicked:', clicked);
await page.waitForTimeout(1500);

try {
  await page.waitForSelector('.portal-scroll', { timeout: 10_000 });
} catch {
  console.log('no .portal-scroll');
  await page.screenshot({ path: '/tmp/portal-diag-miss.png' });
  process.exit(1);
}

await page.screenshot({ path: '/tmp/portal-diag-after.png' });

const report = await page.evaluate(() => {
  const sel = document.querySelectorAll('.portal-scroll');
  return {
    count: sel.length,
    scrolls: [...sel].map((el, i) => {
      const cs = getComputedStyle(el);
      return {
        idx: i,
        classes: el.className.slice(0, 120),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        canScroll: el.scrollHeight > el.clientHeight,
        overflowY: cs.overflowY,
        maxHeight: cs.maxHeight,
        height: cs.height,
      };
    }),
  };
});

console.log('\n=== REPORT ===');
console.log(JSON.stringify(report, null, 2));

await browser.close();
