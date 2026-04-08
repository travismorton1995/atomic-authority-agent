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

  // Split page into Discovery and Engagement sections
  const discoveryIdx = lines.findIndex(l => l === 'Discovery');
  const engagementIdx = lines.findIndex(l => l === 'Engagement');
  const demographicsIdx = lines.findIndex(l => l === 'Top demographics');

  const discoveryLines = discoveryIdx >= 0 && engagementIdx > discoveryIdx
    ? lines.slice(discoveryIdx, engagementIdx) : [];
  const engagementLines = engagementIdx >= 0
    ? lines.slice(engagementIdx, demographicsIdx > engagementIdx ? demographicsIdx : engagementIdx + 30) : [];

  const discoveryLookup = buildLookup(discoveryLines, 'number-first');
  const engagementLookup = buildLookup(engagementLines, 'label-first');

  const raw = {
    impressions: discoveryLookup.get('impressions'),
    membersReached: discoveryLookup.get('members reached'),
    reactions: engagementLookup.get('reactions'),
    comments: engagementLookup.get('comments'),
    reposts: engagementLookup.get('reposts'),
    saves: engagementLookup.get('saves'),
    sends: engagementLookup.get('sends on linkedin'),
    newFollowers: discoveryLookup.get('followers gained from this post'),
  };

  return {
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

  const release = await acquireBrowserLock();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    for (const post of postsWithUrl) {
      const urn = extractUrn(post.linkedInPostUrl);
      console.log(`\n[${post.draft?.postType}] "${post.draft?.sourceTitle?.slice(0, 60)}"`);
      if (!urn) {
        console.warn(`  Could not extract URN from: ${post.linkedInPostUrl}`);
        continue;
      }
      try {
        const metrics = await scrapePostAnalytics(page, urn);
        post.metrics = metrics;
        console.log(`  Impressions: ${metrics.impressions ?? 'n/a'} | Reactions: ${metrics.reactions ?? 'n/a'} | Comments: ${metrics.comments ?? 'n/a'} | Reposts: ${metrics.reposts ?? 'n/a'} | Saves: ${metrics.saves ?? 'n/a'} | Followers: ${metrics.newFollowers ?? 'n/a'}`);
      } catch (err) {
        console.warn(`  Failed to fetch metrics: ${(err as Error).message}`);
      }
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
  await sendMessage(message);
  console.log('Weekly report sent.');
}

// Only run when executed directly, not when imported by the scheduler
const isMain = process.argv[1]?.endsWith('fetch-metrics.ts') || process.argv[1]?.endsWith('fetch-metrics.js');
if (isMain) runMetricsFetch().catch(console.error);
