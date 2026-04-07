// npm run test-mentions
// Opens LinkedIn composer in a headed browser and walks through each entry
// in the mentions dictionary. For each one, types @searchTerm and pauses so
// you can visually confirm the correct company appears as the first result.
// Press y to mark verified, n to skip, r to remove from dictionary, q to quit.

import 'dotenv/config';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chromium } from 'playwright';
import { MENTIONS, removeMentionEntry } from '../poster/mentions.js';

const USER_DATA_DIR = path.resolve('user_data');
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

async function openComposer(page: import('playwright').Page): Promise<void> {
  await page.goto(LINKEDIN_FEED, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Check if we're logged in — if not, wait for the user to log in manually
  const startPostBtn = page.locator('[aria-label="Start a post"]').first();
  const isLoggedIn = await startPostBtn.isVisible({ timeout: 5000 }).catch(() => false);
  if (!isLoggedIn) {
    console.log('\nNot logged in. Please log into LinkedIn in the browser window.');
    console.log('Waiting for login...');
    await startPostBtn.waitFor({ state: 'visible', timeout: 300000 }); // 5 min to log in
    console.log('Logged in. Starting tests...');
    await page.waitForTimeout(2000);
  }

  await startPostBtn.click();
  await page.waitForTimeout(1000);

  const textArea = page.locator('.share-box-v2__modal div[contenteditable="true"], div[role="textbox"], .ql-editor').first();
  try {
    await textArea.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    // Retry — sometimes the first click doesn't open the composer
    console.log('Composer did not open, retrying...');
    await startPostBtn.click();
    await textArea.waitFor({ state: 'visible', timeout: 20000 });
  }
  await page.waitForTimeout(500);
  await textArea.click();
}

async function clearComposer(page: import('playwright').Page): Promise<void> {
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
}

async function testEntry(page: import('playwright').Page, searchTerm: string): Promise<void> {
  await clearComposer(page);
  await page.keyboard.type(`@${searchTerm}`, { delay: 40 });
  // Wait 3s for the dropdown to appear so user can see it
  await page.waitForTimeout(3000);
}

async function markVerified(name: string): Promise<void> {
  if (MENTIONS[name]) {
    MENTIONS[name].verified = true;
    const { readFileSync, writeFileSync } = await import('fs');
    const { resolve } = await import('path');
    const MENTIONS_FILE = resolve(process.cwd(), 'src/poster/mentions.ts');
    let src = readFileSync(MENTIONS_FILE, 'utf8').replace(/\r\n/g, '\n');
    const startMarker = 'export const MENTIONS: Record<string, MentionEntry> = {';
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf('\n};\n', startIdx);
    if (startIdx === -1 || endIdx === -1) { console.warn('Could not rewrite mentions file.'); return; }

    const entries = Object.entries(MENTIONS);
    const verified = entries.filter(([, v]) => v.verified).sort(([a], [b]) => a.localeCompare(b));
    const unverified = entries.filter(([, v]) => !v.verified).sort(([a], [b]) => a.localeCompare(b));
    const sorted = [...verified, ...unverified];

    let block = '';
    for (const [n, entry] of sorted) {
      const safe = n.replace(/'/g, "\\'");
      const searchSafe = entry.searchTerm.replace(/'/g, "\\'");
      const pad = Math.max(1, 42 - safe.length);
      const searchPad = Math.max(1, 27 - searchSafe.length);
      block += `  '${safe}':${' '.repeat(pad)}{ searchTerm: '${searchSafe}',${' '.repeat(searchPad)}verified: ${entry.verified} },\n`;
    }

    src = src.slice(0, startIdx + startMarker.length + 1) + block + src.slice(endIdx + 1);
    writeFileSync(MENTIONS_FILE, src, 'utf8');
    console.log(`  Marked "${name}" as verified.`);
  } else {
    console.warn(`  Could not find entry for "${name}".`);
  }
}

(async () => {
  const entries = Object.entries(MENTIONS);
  const unverified = entries.filter(([, e]) => !e.verified);

  if (unverified.length === 0) {
    console.log('All entries are already verified. Nothing to test.');
    process.exit(0);
  }

  // Copy user_data to a temp directory so we don't conflict with
  // the scheduler or the user's personal Chrome instance.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-mentions-'));
  console.log('Copying LinkedIn session to temp profile...');
  fs.cpSync(USER_DATA_DIR, tmpDir, { recursive: true });
  // Remove Chrome's profile lock from the copy so Playwright can open it
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(tmpDir, lock), { force: true }); } catch {}
  }

  console.log(`\nTesting ${unverified.length} unverified mention(s).`);
  console.log('Controls: y = verified, n = skip, r = remove, q = quit\n');

  const context = await chromium.launchPersistentContext(tmpDir, {
    channel: 'chrome',
    headless: false,
    locale: 'en-US',
    timezoneId: 'America/Toronto',
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    await openComposer(page);

    for (const [name, entry] of unverified) {
      console.log(`\nTesting: "${name}"  →  @${entry.searchTerm}`);
      await testEntry(page, entry.searchTerm);

      const answer = await prompt('  Correct company in dropdown? (y/n/r/q): ');
      if (answer === 'q') break;
      if (answer === 'y') await markVerified(name);
      if (answer === 'r') removeMentionEntry(name);
    }
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\nDone. Run npm run test-mentions again to test remaining entries.');
  process.exit(0);
})();
