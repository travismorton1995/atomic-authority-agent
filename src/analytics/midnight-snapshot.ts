// Midnight snapshot job — runs at midnight ET via scheduler.
// Single browser session collects: follower count, post metrics (90d), comment metrics (15d).
// Then computes organic attribution for the day that just ended.
// Retries on failure with exponential backoff. Sends Telegram alert if all retries exhausted.

import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import { acquireBrowserLock } from '../poster/browser-lock.js';
import { scrapeFollowerCount, recordSnapshot } from './followers.js';
import { scrapeAllPostMetrics } from '../cli/fetch-metrics.js';
import { scrapeCommentMetrics } from '../outbound/comment-metrics.js';
import { computeAndSaveAttribution } from './organic-attribution.js';
import { sendAlert } from '../hitl/telegram.js';

const USER_DATA_DIR = path.resolve('user_data');
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 60_000; // 1 minute, doubles each retry

interface SnapshotResult {
  followers: boolean;
  postMetrics: boolean;
  commentMetrics: boolean;
  attribution: boolean;
}

/**
 * Run a single attempt of the midnight snapshot. Returns which steps succeeded.
 */
async function runSnapshotAttempt(): Promise<SnapshotResult> {
  const result: SnapshotResult = { followers: false, postMetrics: false, commentMetrics: false, attribution: false };

  const release = await acquireBrowserLock(120_000);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    // 1. Follower count
    console.log('[midnight] Scraping follower count...');
    try {
      const count = await scrapeFollowerCount(page);
      if (count) {
        recordSnapshot(count);
        result.followers = true;
        console.log(`[midnight] Follower count: ${count} ✓`);
      } else {
        console.warn('[midnight] Could not extract follower count — session may be expired.');
      }
    } catch (err) {
      console.error(`[midnight] Follower scrape failed: ${(err as Error).message}`);
    }

    // 2. Post metrics (last 90 days)
    console.log('[midnight] Fetching post metrics...');
    try {
      const sessionAlive = await scrapeAllPostMetrics(page);
      result.postMetrics = sessionAlive;
      console.log(`[midnight] Post metrics: ${sessionAlive ? '✓' : 'no data (session dead?)'}`);
    } catch (err) {
      console.error(`[midnight] Post metrics failed: ${(err as Error).message}`);
    }

    // 3. Comment metrics (last 15 days, excluding self-post comments)
    console.log('[midnight] Scraping comment metrics...');
    try {
      await scrapeCommentMetrics(page);
      result.commentMetrics = true;
      console.log('[midnight] Comment metrics: ✓');
    } catch (err) {
      console.error(`[midnight] Comment metrics failed: ${(err as Error).message}`);
    }
  } finally {
    await context.close();
    release();
  }

  // 4. Compute organic attribution (no browser needed)
  console.log('[midnight] Computing organic attribution...');
  try {
    computeAndSaveAttribution();
    result.attribution = true;
    console.log('[midnight] Attribution: ✓');
  } catch (err) {
    console.error(`[midnight] Attribution computation failed: ${(err as Error).message}`);
  }

  return result;
}

/**
 * Run the full midnight snapshot with retry logic.
 * Retries up to MAX_RETRIES times with exponential backoff on browser/scraping failures.
 * Sends a Telegram alert if all retries are exhausted.
 */
export async function runMidnightSnapshot(): Promise<void> {
  console.log('[midnight] Starting midnight snapshot...');

  let lastResult: SnapshotResult | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[midnight] Attempt ${attempt}/${MAX_RETRIES}...`);

    try {
      lastResult = await runSnapshotAttempt();
    } catch (err) {
      console.error(`[midnight] Attempt ${attempt} crashed: ${(err as Error).message}`);
      lastResult = { followers: false, postMetrics: false, commentMetrics: false, attribution: false };
    }

    // Check if critical steps succeeded
    const critical = lastResult.followers && lastResult.postMetrics;
    if (critical) {
      const parts = [
        lastResult.followers ? 'followers ✓' : 'followers ✗',
        lastResult.postMetrics ? 'post metrics ✓' : 'post metrics ✗',
        lastResult.commentMetrics ? 'comment metrics ✓' : 'comment metrics ✗',
        lastResult.attribution ? 'attribution ✓' : 'attribution ✗',
      ];
      console.log(`[midnight] Snapshot complete on attempt ${attempt}: ${parts.join(', ')}`);

      // Non-critical failures: log but don't retry
      if (!lastResult.commentMetrics) {
        console.warn('[midnight] Comment metrics failed but not retrying — non-critical.');
      }
      if (!lastResult.attribution) {
        console.warn('[midnight] Attribution failed but not retrying — will recompute next run.');
      }
      return;
    }

    // Critical failure — retry with backoff
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[midnight] Critical step failed — retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  const failedSteps = [];
  if (!lastResult?.followers) failedSteps.push('follower count');
  if (!lastResult?.postMetrics) failedSteps.push('post metrics');
  if (!lastResult?.commentMetrics) failedSteps.push('comment metrics');
  if (!lastResult?.attribution) failedSteps.push('attribution');

  const message =
    `⚠️ Midnight snapshot failed after ${MAX_RETRIES} attempts.\n\n` +
    `Failed: ${failedSteps.join(', ')}\n\n` +
    `LinkedIn session may be expired. Send /login to renew, or run manually:\n` +
    '`npx tsx src/analytics/midnight-snapshot.ts`';

  console.error(`[midnight] All ${MAX_RETRIES} retries exhausted. Alerting via Telegram.`);
  try {
    await sendAlert(message);
  } catch (err) {
    console.error(`[midnight] Failed to send Telegram alert: ${(err as Error).message}`);
  }
}
