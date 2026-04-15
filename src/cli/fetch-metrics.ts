import 'dotenv/config';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { sendMessage } from '../hitl/telegram.js';
import { acquireBrowserLock } from '../poster/browser-lock.js';

const USER_DATA_DIR = path.resolve('user_data');
const HISTORY_FILE = 'posted_history.json';

export interface PostMetrics {
  fetchedAt: string;
  impressions: number | null;
  membersReached: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  saves: number | null;
  sends: number | null;
  newFollowers: number | null;
}

// Delegate to the canonical composite score in the analytics module.
import { compositeScore as _compositeScore } from '../analytics/post-data.js';
export function computeCompositeScore(m: PostMetrics | null | undefined): number {
  return _compositeScore(m);
}

function parseNumber(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? null : n;
}

// Extracts the activity URN from a LinkedIn post URL.
// e.g. "https://www.linkedin.com/feed/update/urn:li:activity:7444736016478846976/" → "urn:li:activity:7444736016478846976"
function extractUrn(postUrl: string): string | null {
  const match = postUrl.match(/(urn:li:activity:\d+)/);
  return match ? match[1] : null;
}

// Scrapes the per-post analytics page at /analytics/post-summary/{urn}/
// This gives us impressions, members reached, saves, sends, and new followers
// in addition to the basic reactions/comments/reposts.
async function scrapePostAnalytics(page: import('playwright').Page, urn: string): Promise<PostMetrics> {
  const url = `https://www.linkedin.com/analytics/post-summary/${urn}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const pageText = await page.evaluate('document.body.innerText') as string;

  // Debug: log page start if no metrics are found (helps diagnose layout changes)
  const debugSnippet = pageText.replace(/\n/g, ' | ').slice(0, 200);

  // LinkedIn analytics page has two sections with different patterns:
  //   Discovery: "1,938\nImpressions\n1,071\nMembers reached" (number BEFORE label)
  //   Engagement: "Reactions\n68\nComments\n1\nReposts\n3" (label BEFORE number)
  // Parse each section separately to avoid cross-contamination.
  const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);

  // Build a lookup: for each adjacent pair, map label→number.
  // priority controls which direction wins on collision:
  //   'number-first': "4604\nImpressions" → Impressions=4604 (Discovery section)
  //   'label-first': "Reactions\n68" → Reactions=68 (Engagement section)
  const buildLookup = (sectionLines: string[], priority: 'number-first' | 'label-first'): Map<string, string> => {
    const map = new Map<string, string>();
    const weak = priority === 'number-first' ? 'label-first' : 'number-first';
    // First pass: weak direction
    for (let i = 0; i < sectionLines.length - 1; i++) {
      const curr = sectionLines[i];
      const next = sectionLines[i + 1];
      if (weak === 'label-first' && !/^[\d,]+$/.test(curr) && /^[\d,]+$/.test(next)) {
        map.set(curr.toLowerCase(), next);
      }
      if (weak === 'number-first' && /^[\d,]+$/.test(curr) && !/^[\d,]+$/.test(next)) {
        map.set(next.toLowerCase(), curr);
      }
    }
    // Second pass: strong direction (overwrites)
    for (let i = 0; i < sectionLines.length - 1; i++) {
      const curr = sectionLines[i];
      const next = sectionLines[i + 1];
      if (priority === 'label-first' && !/^[\d,]+$/.test(curr) && /^[\d,]+$/.test(next)) {
        map.set(curr.toLowerCase(), next);
      }
      if (priority === 'number-first' && /^[\d,]+$/.test(curr) && !/^[\d,]+$/.test(next)) {
        map.set(next.toLowerCase(), curr);
      }
    }
    return map;
  };

  // Split page into sections — LinkedIn uses varying labels, match flexibly
  const discoveryIdx = lines.findIndex(l => /^discovery$/i.test(l));
  const profileIdx = lines.findIndex(l => /^profile activity$/i.test(l));
  const engagementIdx = lines.findIndex(l => /social engagement|^engagement$/i.test(l));
  const demographicsIdx = lines.findIndex(l => /demographics/i.test(l));

  const discoveryEnd = [profileIdx, engagementIdx, demographicsIdx].find(i => i > discoveryIdx) ?? discoveryIdx + 20;
  const engagementEnd = demographicsIdx > engagementIdx ? demographicsIdx : engagementIdx + 20;

  const discoveryLines = discoveryIdx >= 0 ? lines.slice(discoveryIdx, discoveryEnd) : [];
  const profileLines = profileIdx >= 0 ? lines.slice(profileIdx, engagementIdx > profileIdx ? engagementIdx : profileIdx + 10) : [];
  const engagementLines = engagementIdx >= 0 ? lines.slice(engagementIdx, engagementEnd) : [];

  const discoveryLookup = buildLookup(discoveryLines, 'number-first');
  const profileLookup = buildLookup(profileLines, 'label-first');
  const engagementLookup = buildLookup(engagementLines, 'label-first');

  const raw = {
    impressions: discoveryLookup.get('impressions'),
    membersReached: discoveryLookup.get('members reached'),
    reactions: engagementLookup.get('reactions'),
    comments: engagementLookup.get('comments'),
    reposts: engagementLookup.get('reposts'),
    saves: engagementLookup.get('saves'),
    sends: engagementLookup.get('sends on linkedin'),
    newFollowers: profileLookup.get('followers gained from this post')
      ?? discoveryLookup.get('followers gained from this post'),
  };

  const result: PostMetrics = {
    fetchedAt: new Date().toISOString(),
    impressions: parseNumber(raw.impressions),
    membersReached: parseNumber(raw.membersReached),
    reactions: parseNumber(raw.reactions),
    comments: parseNumber(raw.comments),
    reposts: parseNumber(raw.reposts),
    saves: parseNumber(raw.saves),
    sends: parseNumber(raw.sends),
    newFollowers: parseNumber(raw.newFollowers),
  };

  // Log debug info if nothing was parsed — helps diagnose layout changes
  if (result.impressions === null && result.reactions === null && result.comments === null) {
    console.warn(`  [debug] No metrics found. Discovery section: ${discoveryLines.length} lines, Engagement: ${engagementLines.length} lines`);
    console.warn(`  [debug] Page start: ${debugSnippet}`);
  }

  return result;
}

export async function runMetricsFetch() {
  if (!existsSync(HISTORY_FILE)) {
    console.log('No posted_history.json found.');
    return;
  }

  const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const postsWithUrl = history.filter((p: any) =>
    p.linkedInPostUrl &&
    p.publishedAt &&
    new Date(p.publishedAt).getTime() >= cutoff
  );

  if (postsWithUrl.length === 0) {
    console.log('No posts with LinkedIn URLs in the last 90 days.');
    return;
  }

  console.log(`Fetching metrics for ${postsWithUrl.length} post(s) (last 90 days)...`);

  const release = await acquireBrowserLock(60_000);
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
    let sessionChecked = false;

    for (const post of postsWithUrl) {
      const urn = extractUrn(post.linkedInPostUrl);
      console.log(`\n[${post.draft?.postType}] "${post.draft?.sourceTitle?.slice(0, 60)}"`);
      if (!urn) {
        console.warn(`  Could not extract URN from: ${post.linkedInPostUrl}`);
        continue;
      }
      try {
        const metrics = await scrapePostAnalytics(page, urn);
        // Only update if scrape returned actual data — don't overwrite good metrics with nulls
        const hasData = metrics.impressions !== null || metrics.reactions !== null || metrics.comments !== null;
        if (hasData) {
          sessionChecked = true;
          post.metrics = metrics;
          console.log(`  Impressions: ${metrics.impressions ?? 'n/a'} | Reactions: ${metrics.reactions ?? 'n/a'} | Comments: ${metrics.comments ?? 'n/a'} | Reposts: ${metrics.reposts ?? 'n/a'} | Saves: ${metrics.saves ?? 'n/a'} | Followers: ${metrics.newFollowers ?? 'n/a'}`);
        } else {
          console.warn(`  Scrape returned no data — keeping previous metrics.`);
          // If the very first post returns no data, session is likely dead — abort early
          if (!sessionChecked) {
            console.error('Metrics fetch: first post returned no data — session may be expired. Aborting.');
            break;
          }
        }
      } catch (err) {
        console.warn(`  Failed to fetch metrics: ${(err as Error).message}`);
      }
    }

    // Scrape total follower count from audience analytics (reuse browser session)
    try {
      const { scrapeFollowerCount, recordSnapshot } = await import('../analytics/followers.js');
      const followerCount = await scrapeFollowerCount(page);
      if (followerCount) {
        recordSnapshot(followerCount);
      }
    } catch (err) {
      console.warn(`[followers] Scrape failed (non-fatal): ${(err as Error).message}`);
    }
  } finally {
    await context.close();
    release();
  }

  const raw = JSON.stringify(history, null, 2);
  const collapsed = raw.replace(
    /\[\n(\s+)"([^"]+)"(,\n\s+"[^"]+")*\n\s+\]/g,
    (match) => {
      const items = [...match.matchAll(/"([^"]+)"/g)].map(m => `"${m[1]}"`);
      const oneLine = `[${items.join(', ')}]`;
      return oneLine.length <= 120 ? oneLine : match;
    },
  );
  writeFileSync(HISTORY_FILE, collapsed);
  console.log('\nMetrics saved to posted_history.json.');
}

export async function runWeeklyReport(): Promise<void> {
  const { generateReportData, formatReportMessage } = await import('../analytics/report.js');
  const { loadPostsWithMetrics } = await import('../analytics/post-data.js');

  const posts = loadPostsWithMetrics();
  if (posts.length === 0) {
    console.log('No published posts with metrics — skipping report.');
    return;
  }

  const data = generateReportData();
  const message = formatReportMessage(data);

  console.log('Sending weekly report to Telegram...');
  await sendMessage(message, 'HTML');
  console.log('Weekly report sent.');
}

// Only run when executed directly, not when imported by the scheduler
const isMain = process.argv[1]?.endsWith('fetch-metrics.ts') || process.argv[1]?.endsWith('fetch-metrics.js');
if (isMain) runMetricsFetch().catch(console.error);
