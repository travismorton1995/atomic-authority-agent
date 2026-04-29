// 90-minute early performance snapshot.
// Scrapes metrics for the most recent post ~90 min after publishing,
// computes composite score, and saves it as `earlyScore` on the post.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import path from 'path';
import { acquireBrowserLock } from '../poster/browser-lock.js';
import { compositeScore } from './post-data.js';

const HISTORY_FILE = 'posted_history.json';
const USER_DATA_DIR = path.resolve('user_data');

// Re-use the scrapePostAnalytics function from fetch-metrics
// We import it dynamically to avoid circular dependency issues

function extractUrn(postUrl: string): string | null {
  const match = postUrl.match(/(urn:li:activity:\d+)/);
  return match ? match[1] : null;
}

/**
 * Check if the most recent post is due for an early score snapshot.
 * Returns the post if it's between 85-100 min old and doesn't have earlyScore yet.
 */
export function getPostNeedingEarlyScore(): { id: string; linkedInPostUrl: string; publishedAt: string } | null {
  if (!existsSync(HISTORY_FILE)) return null;

  let history: any[];
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return null;
  }

  const published = history
    .filter((p: any) => p.status === 'published' && p.publishedAt && p.linkedInPostUrl)
    .sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  if (published.length === 0) return null;

  const most = published[0];
  if (most.earlyScore !== undefined) return null; // already captured

  const ageMs = Date.now() - new Date(most.publishedAt).getTime();
  const ageMin = ageMs / 60_000;

  // Window: 85-100 minutes after publish
  if (ageMin < 85 || ageMin > 100) return null;

  return { id: most.id, linkedInPostUrl: most.linkedInPostUrl, publishedAt: most.publishedAt };
}

/**
 * Scrape metrics for a single post and save the early composite score.
 */
export async function captureEarlyScore(post: { id: string; linkedInPostUrl: string }): Promise<number | null> {
  const urn = extractUrn(post.linkedInPostUrl);
  if (!urn) {
    console.warn('[early-score] Could not extract URN from:', post.linkedInPostUrl);
    return null;
  }

  const release = await acquireBrowserLock(30_000);
  let score: number | null = null;

  try {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: process.env.LINKEDIN_HEADLESS === 'true',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    const page = context.pages()[0] ?? await context.newPage();

    try {
      const { scrapePostAnalytics } = await import('../cli/fetch-metrics.js');
      const metrics = await scrapePostAnalytics(page, urn);

      const hasData = metrics.impressions !== null || metrics.reactions !== null;
      if (hasData) {
        score = compositeScore(metrics);
        console.log(`[early-score] Post ${post.id}: score=${score.toFixed(1)} (impressions=${metrics.impressions}, reactions=${metrics.reactions}, comments=${metrics.comments}, reposts=${metrics.reposts})`);

        // Save to posted_history.json
        const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
        const entry = history.find((p: any) => p.id === post.id);
        if (entry) {
          entry.earlyScore = score;
          entry.earlyMetrics = metrics;
          writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
          console.log(`[early-score] Saved earlyScore=${score.toFixed(1)} for post ${post.id}`);
        }
      } else {
        console.warn('[early-score] Scrape returned no data — session may be expired.');
      }
    } finally {
      await context.close();
    }
  } catch (err) {
    console.error(`[early-score] Failed: ${(err as Error).message}`);
  } finally {
    release();
  }

  return score;
}
