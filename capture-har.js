import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config (override via env vars) ---------------------------------------
const HOME_URL = process.env.HOME_URL || 'https://automobiles.honda.com';
const TARGET_URL = process.env.TARGET_URL || 'https://automobiles.honda.com/tools/build-and-price';
const HEADLESS = process.env.HEADLESS === '1';
const KEEP_OPEN_MS = Number(process.env.KEEP_OPEN_MS || 8000);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(__dirname, 'har');
mkdirSync(outDir, { recursive: true });
const harPath = join(outDir, `honda-build-and-price-${stamp}.har`);
const shotPath = join(outDir, `honda-build-and-price-${stamp}.png`);

console.log('Launching browser (traffic will route through the GSA client on this machine)...');
const browser = await chromium.launch({ headless: HEADLESS });

// recordHarMode 'full' captures request + response bodies, not just headers.
const context = await browser.newContext({
  recordHar: { path: harPath, mode: 'full', content: 'embed' },
  ignoreHTTPSErrors: true,
});

const page = await context.newPage();
page.on('response', (r) => console.log(`  ${r.status()}  ${r.url()}`));

try {
  console.log(`\n1) Navigating to home page: ${HOME_URL}`);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    console.log(`   home nav warning: ${e.message}`);
  });

  // Try to click a "Build & Price" link to mimic the real user flow.
  console.log('\n2) Looking for a "Build & Price" link to click...');
  const link = page
    .getByRole('link', { name: /build\s*&?\s*price/i })
    .first();

  let clicked = false;
  try {
    await link.waitFor({ state: 'visible', timeout: 8000 });
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
      link.click({ timeout: 8000 }),
    ]);
    clicked = true;
    console.log('   Clicked "Build & Price" link.');
  } catch {
    console.log('   Link not found/clickable; navigating directly to target instead.');
  }

  if (!clicked) {
    console.log(`\n3) Navigating directly to target: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      console.log(`   target nav warning: ${e.message}`);
    });
  }

  await page.waitForTimeout(2500);
  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);

  console.log(`\nFinal URL:   ${finalUrl}`);
  console.log(`Page title:  ${title}`);
  console.log(`Body sample: ${bodyText.replace(/\s+/g, ' ').trim()}`);

  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
  if (!HEADLESS) await page.waitForTimeout(KEEP_OPEN_MS);
} finally {
  // Closing the context flushes the HAR to disk.
  await context.close();
  await browser.close();
  console.log(`\nHAR saved:        ${harPath}`);
  console.log(`Screenshot saved: ${shotPath}`);
}
