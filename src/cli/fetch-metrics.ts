import 'dotenv/config';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { sendMessage, sendPhotoBuffer, sendDocumentBuffer } from '../hitl/telegram.js';
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
export async function scrapePostAnalytics(page: import('playwright').Page, urn: string): Promise<PostMetrics> {
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

/** Collapse short JSON arrays onto single lines for readability. */
function collapseShortArrays(json: string): string {
  return json.replace(
    /\[\n(\s+)"([^"]+)"(,\n\s+"[^"]+")*\n\s+\]/g,
    (match) => {
      const items = [...match.matchAll(/"([^"]+)"/g)].map(m => `"${m[1]}"`);
      const oneLine = `[${items.join(', ')}]`;
      return oneLine.length <= 120 ? oneLine : match;
    },
  );
}

/**
 * Scrape metrics for all published posts (last 90 days) using an existing Playwright page.
 * Updates posted_history.json in place. Reusable by both runMetricsFetch() and the midnight snapshot.
 * Returns true if at least one post returned data (session is alive).
 */
export async function scrapeAllPostMetrics(page: import('playwright').Page): Promise<boolean> {
  if (!existsSync(HISTORY_FILE)) {
    console.log('No posted_history.json found.');
    return false;
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
    return false;
  }

  console.log(`Fetching metrics for ${postsWithUrl.length} post(s) (last 90 days)...`);

  let sessionChecked = false;
  let consecutiveFailures = 0;
  const CIRCUIT_BREAKER_LIMIT = 3;

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
        consecutiveFailures = 0;
        post.metrics = metrics;
        console.log(`  Impressions: ${metrics.impressions ?? 'n/a'} | Reactions: ${metrics.reactions ?? 'n/a'} | Comments: ${metrics.comments ?? 'n/a'} | Reposts: ${metrics.reposts ?? 'n/a'} | Saves: ${metrics.saves ?? 'n/a'} | Followers: ${metrics.newFollowers ?? 'n/a'}`);
      } else {
        consecutiveFailures++;
        console.warn(`  Scrape returned no data — keeping previous metrics. (${consecutiveFailures} consecutive failures)`);
        // If the very first post returns no data, session is likely dead — abort early
        if (!sessionChecked) {
          console.error('Metrics fetch: first post returned no data — session may be expired. Aborting.');
          break;
        }
        if (consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
          console.error(`Metrics fetch: ${CIRCUIT_BREAKER_LIMIT} consecutive failures — circuit breaker tripped. Aborting.`);
          break;
        }
      }
    } catch (err) {
      consecutiveFailures++;
      console.warn(`  Failed to fetch metrics: ${(err as Error).message} (${consecutiveFailures} consecutive failures)`);
      if (consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
        console.error(`Metrics fetch: ${CIRCUIT_BREAKER_LIMIT} consecutive failures — circuit breaker tripped. Aborting.`);
        break;
      }
    }
  }

  writeFileSync(HISTORY_FILE, collapseShortArrays(JSON.stringify(history, null, 2)));
  console.log('\nMetrics saved to posted_history.json.');
  return sessionChecked;
}

export async function runMetricsFetch() {
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
    await scrapeAllPostMetrics(page);
  } finally {
    await context.close();
    release();
  }
}

const REPORT_CACHE_DIR = 'generated_reports';

export async function runWeeklyReport(): Promise<void> {
  const { generateReportData, formatReportMessage } = await import('../analytics/report.js');
  const { loadPostsWithMetrics } = await import('../analytics/post-data.js');

  const posts = loadPostsWithMetrics();
  if (posts.length === 0) {
    console.log('No published posts with metrics — skipping report.');
    return;
  }

  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  const cachedPdfPath = `${REPORT_CACHE_DIR}/atomic-dispatch-${dateStr}.pdf`;

  // Check if today's report already exists — resend instead of regenerating
  if (existsSync(cachedPdfPath)) {
    console.log(`Report already generated today — resending cached PDF: ${cachedPdfPath}`);
    const cached = readFileSync(cachedPdfPath);
    await sendDocumentBuffer(cached, `atomic-dispatch-${dateStr}.pdf`, 'Performance Report', true);
    console.log('Cached PDF report sent to Telegram.');
    return;
  }

  const data = generateReportData();
  const message = formatReportMessage(data);

  // Generate PDF report
  let pdfSent = false;
  try {
    const { generatePdfReport } = await import('../analytics/pdf-report.js');
    const pdfBuffer = await generatePdfReport();

    // Cache the PDF locally
    if (!existsSync(REPORT_CACHE_DIR)) mkdirSync(REPORT_CACHE_DIR, { recursive: true });
    writeFileSync(cachedPdfPath, pdfBuffer);

    await sendDocumentBuffer(pdfBuffer, `atomic-dispatch-${dateStr}.pdf`, 'Performance Report', true);
    pdfSent = true;
    console.log('PDF report generated, cached, and sent to Telegram.');
  } catch (err) {
    console.warn(`PDF generation failed (falling back to text+charts): ${(err as Error).message}`);
  }

  // Send text report and charts only if PDF failed (fallback)
  if (!pdfSent) {
    console.log('Sending text report to Telegram (PDF fallback)...');
    await sendMessage(message, 'HTML');
    let charts: Array<{ name: string; buffer: Buffer; caption: string }> = [];
    try {
      const { generateAllCharts } = await import('../analytics/chart.js');
      charts = await generateAllCharts();
    } catch (err) {
      console.warn(`Chart generation failed (non-fatal): ${(err as Error).message}`);
    }
    for (const chart of charts) {
      await sendPhotoBuffer(chart.buffer, chart.caption);
    }
  }
  console.log('Weekly report sent.');
}

// Only run when executed directly, not when imported by the scheduler
const isMain = process.argv[1]?.endsWith('fetch-metrics.ts') || process.argv[1]?.endsWith('fetch-metrics.js');
if (isMain) runMetricsFetch().catch(console.error);
