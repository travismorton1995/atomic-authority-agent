import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Page } from 'playwright';

const FOLLOWERS_FILE = 'follower_history.json';
const BASELINE_DATE = '2026-03-18';
const BASELINE_COUNT = 350;

export interface FollowerSnapshot {
  date: string;   // YYYY-MM-DD
  total: number;
}

export interface FollowerData {
  current: number;
  allTimeGrowth: number;       // current - baseline (350)
  weeklyGrowth: number | null; // current - 7 days ago (null if no data)
  snapshots: FollowerSnapshot[];
}

function loadHistory(): FollowerSnapshot[] {
  if (!existsSync(FOLLOWERS_FILE)) {
    // Seed with baseline
    const baseline: FollowerSnapshot[] = [{ date: BASELINE_DATE, total: BASELINE_COUNT }];
    writeFileSync(FOLLOWERS_FILE, JSON.stringify(baseline, null, 2), 'utf-8');
    return baseline;
  }
  try {
    return JSON.parse(readFileSync(FOLLOWERS_FILE, 'utf-8')) as FollowerSnapshot[];
  } catch {
    return [{ date: BASELINE_DATE, total: BASELINE_COUNT }];
  }
}

function saveHistory(snapshots: FollowerSnapshot[]): void {
  writeFileSync(FOLLOWERS_FILE, JSON.stringify(snapshots, null, 2), 'utf-8');
}

/**
 * Scrape the current follower count from LinkedIn's audience analytics page.
 * Expects an authenticated Playwright page (reuse from metrics fetch).
 */
export async function scrapeFollowerCount(page: Page): Promise<number | null> {
  try {
    console.log('[followers] Navigating to audience analytics...');
    await page.goto('https://www.linkedin.com/analytics/creator/audience/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.waitForTimeout(3000);

    // The total follower count is typically in a prominent heading or stat card
    const count = await page.evaluate(() => {
      // Try multiple selectors — LinkedIn changes these periodically
      const selectors = [
        // Large stat number near "Total followers"
        'h2',
        '[data-test-id="follower-count"]',
        '.analytics-audience-insights__total-count',
        '.artdeco-card h2',
        '.artdeco-card span[aria-hidden="true"]',
      ];

      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          const text = el.textContent?.trim() ?? '';
          // Look for a number that could be a follower count (3+ digits, possibly with commas)
          const match = text.replace(/,/g, '').match(/^(\d{3,})$/);
          if (match) return parseInt(match[1], 10);
        }
      }

      // Fallback: find any element containing "Total followers" and grab the nearby number
      const allText = document.body.innerText;
      const followerMatch = allText.match(/(\d[\d,]*)\s*Total followers/i)
        ?? allText.match(/Total followers[^\d]*(\d[\d,]*)/i);
      if (followerMatch) {
        return parseInt(followerMatch[1].replace(/,/g, ''), 10);
      }

      return null;
    });

    if (count && count > 0) {
      console.log(`[followers] Current follower count: ${count}`);
      return count;
    }

    console.warn('[followers] Could not extract follower count from page.');
    return null;
  } catch (err) {
    console.warn(`[followers] Failed to scrape: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Record a new follower snapshot. Deduplicates by date (keeps latest per day).
 */
export function recordSnapshot(total: number): void {
  const snapshots = loadHistory();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); // YYYY-MM-DD

  // Update today's entry if it exists, otherwise append
  const existing = snapshots.findIndex(s => s.date === today);
  if (existing >= 0) {
    snapshots[existing].total = total;
  } else {
    snapshots.push({ date: today, total });
  }

  saveHistory(snapshots);
  console.log(`[followers] Snapshot saved: ${total} on ${today}`);
}

/**
 * Load follower data for the report — current count, all-time and weekly growth.
 */
export function getFollowerData(): FollowerData | null {
  const snapshots = loadHistory();
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1];
  const current = latest.total;
  const allTimeGrowth = current - BASELINE_COUNT;

  // Weekly growth: find snapshot closest to 7 days ago
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const targetDate = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  let weeklyGrowth: number | null = null;
  // Find the closest snapshot on or before 7 days ago
  const candidates = snapshots.filter(s => s.date <= targetDate);
  if (candidates.length > 0) {
    const closest = candidates[candidates.length - 1];
    weeklyGrowth = current - closest.total;
  }

  return { current, allTimeGrowth, weeklyGrowth, snapshots };
}
