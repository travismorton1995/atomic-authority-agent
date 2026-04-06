import 'dotenv/config';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { sendMessage } from '../hitl/telegram.js';

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

// Weighted composite performance score — values metrics by their contribution
// to audience growth. Weights are tunable.
const SCORE_WEIGHTS = {
  newFollowers: 10,   // direct audience growth
  reposts: 5,         // amplification to new audiences
  sends: 5,           // high-trust private sharing
  comments: 3,        // depth of engagement, triggers algorithmic distribution
  saves: 3,           // content quality signal
  reactions: 1,       // low-effort but positive
  impressions: 0.01,  // reach floor — large numbers still contribute
};

export function computeCompositeScore(m: PostMetrics | null | undefined): number {
  if (!m) return 0;
  return (m.newFollowers ?? 0) * SCORE_WEIGHTS.newFollowers
       + (m.reposts ?? 0)      * SCORE_WEIGHTS.reposts
       + (m.sends ?? 0)        * SCORE_WEIGHTS.sends
       + (m.comments ?? 0)     * SCORE_WEIGHTS.comments
       + (m.saves ?? 0)        * SCORE_WEIGHTS.saves
       + (m.reactions ?? 0)    * SCORE_WEIGHTS.reactions
       + (m.impressions ?? 0)  * SCORE_WEIGHTS.impressions;
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
  if (!existsSync(HISTORY_FILE)) {
    console.log('No posted_history.json found — skipping weekly report.');
    return;
  }

  const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const posts = history.filter((p: any) =>
    p.status === 'published' &&
    p.publishedAt &&
    new Date(p.publishedAt).getTime() >= cutoff
  );

  if (posts.length === 0) {
    console.log('No posts in the last 30 days — skipping weekly report.');
    return;
  }

  // Attach composite score and raw metrics to each post
  interface PostWithScore { p: any; score: number; eng: number; impressions: number | null }
  const withScore: PostWithScore[] = posts.map((p: any) => {
    const score = computeCompositeScore(p.metrics);
    const eng = (p.metrics?.reactions ?? 0) + (p.metrics?.comments ?? 0) + (p.metrics?.reposts ?? 0);
    const impressions: number | null = p.metrics?.impressions ?? null;
    return { p, score, eng, impressions };
  });

  const totalReactions    = posts.reduce((s: number, p: any) => s + (p.metrics?.reactions ?? 0), 0);
  const totalComments     = posts.reduce((s: number, p: any) => s + (p.metrics?.comments  ?? 0), 0);
  const totalReposts      = posts.reduce((s: number, p: any) => s + (p.metrics?.reposts   ?? 0), 0);
  const totalImpressions  = posts.reduce((s: number, p: any) => s + (p.metrics?.impressions ?? 0), 0);
  const totalSaves        = posts.reduce((s: number, p: any) => s + (p.metrics?.saves ?? 0), 0);
  const totalNewFollowers = posts.reduce((s: number, p: any) => s + (p.metrics?.newFollowers ?? 0), 0);
  const totalEng = totalReactions + totalComments + totalReposts;
  const avgImpressions = posts.length > 0 ? Math.round(totalImpressions / posts.length) : 0;
  const overallEngRate = totalImpressions > 0 ? ((totalEng / totalImpressions) * 100).toFixed(1) : 'n/a';
  const avgScore = posts.length > 0 ? withScore.reduce((s, { score }) => s + score, 0) / posts.length : 0;

  // Helper: rank by avg composite score
  function rankBy(items: PostWithScore[], extract: (p: any) => string | string[]) {
    const map = new Map<string, { total: number; count: number }>();
    for (const { p, score } of items) {
      const vals = extract(p);
      for (const v of (Array.isArray(vals) ? vals : [vals])) {
        const prev = map.get(v) ?? { total: 0, count: 0 };
        map.set(v, { total: prev.total + score, count: prev.count + 1 });
      }
    }
    return [...map.entries()]
      .map(([label, { total, count }]) => ({ label, avg: total / count, count }))
      .sort((a, b) => b.avg - a.avg);
  }

  const typeRanked    = rankBy(withScore, (p: any) => p.draft?.postType ?? 'unknown');
  const tagRanked     = rankBy(withScore, (p: any) => p.draft?.contentTags ?? []).slice(0, 5);
  const hashtagRanked = rankBy(withScore, (p: any) =>
    (p.finalContent?.match(/#\w+/g) ?? []).map((t: string) => t.toLowerCase())
  ).slice(0, 5);
  const feedRanked    = rankBy(withScore, (p: any) => p.draft?.sourceFeed ?? 'Unknown');
  const dayRanked     = rankBy(withScore, (p: any) =>
    new Date(p.publishedAt).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short' })
  );

  function getTimeWindow(iso: string): string {
    const d = new Date(iso);
    const hour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }), 10);
    if (hour >= 7 && hour < 9)   return 'Morning (7-9am)';
    if (hour >= 12 && hour < 13) return 'Noon (12-1pm)';
    if (hour >= 17 && hour < 19) return 'Evening (5-7pm)';
    return 'Other';
  }
  const windowRanked = rankBy(withScore, (p: any) => getTimeWindow(p.publishedAt));

  // Photo vs no-photo
  const withPhoto    = withScore.filter(({ p }) => !!p.draft?.imageUrl || !!p.draft?.generatedImagePath);
  const withoutPhoto = withScore.filter(({ p }) => !p.draft?.imageUrl && !p.draft?.generatedImagePath);
  const photoAvg    = withPhoto.length    ? withPhoto.reduce((s, { score }) => s + score, 0)    / withPhoto.length    : null;
  const noPhotoAvg  = withoutPhoto.length ? withoutPhoto.reduce((s, { score }) => s + score, 0) / withoutPhoto.length : null;

  // Best individual post
  const best = [...withScore].sort((a, b) => b.score - a.score)[0];
  const bestSnippet = best.p.finalContent?.split('\n')[0]?.slice(0, 80) ?? '';
  const bestType = best.p.draft?.postType ?? 'unknown';

  const medals = ['🥇', '🥈', '🥉'];
  const fmt = (n: number) => n.toFixed(1);

  const dateStart = new Date(cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });
  const dateEnd   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });

  const rankLine = (r: { label: string; avg: number; count: number }, i: number) =>
    `${medals[i] ?? '  •'} \`${r.label}\` — avg ${fmt(r.avg)} score (${r.count} post${r.count !== 1 ? 's' : ''})`;

  const typeLines = typeRanked.map(rankLine).join('\n');

  const tagLines = tagRanked.length > 0
    ? tagRanked.map(rankLine).join('\n')
    : '  _(no tags)_';

  const feedLines = feedRanked.map(rankLine).join('\n');

  const hashtagLines = hashtagRanked.length > 0
    ? hashtagRanked.map(rankLine).join('\n')
    : '  _(no hashtags found)_';

  const dayLines = dayRanked.map(rankLine).join('\n');
  const windowLines = windowRanked.map(rankLine).join('\n');

  const photoLine = [
    withPhoto.length    ? `📷 with photo (${withPhoto.length}): avg ${fmt(photoAvg!)} score`       : null,
    withoutPhoto.length ? `🚫 no photo (${withoutPhoto.length}): avg ${fmt(noPhotoAvg!)} score` : null,
  ].filter(Boolean).join(' | ');

  const message =
`📊 *Monthly Report* (${dateStart}–${dateEnd})

*Posts published:* ${posts.length}
*Impressions:* ${totalImpressions.toLocaleString()} (avg ${avgImpressions.toLocaleString()}/post)
*Engagement rate:* ${overallEngRate}%
*Reactions:* ${totalReactions} | *Comments:* ${totalComments} | *Reposts:* ${totalReposts}
*Saves:* ${totalSaves} | *New followers:* ${totalNewFollowers}
*Avg composite score:* ${fmt(avgScore)}
${photoLine ? `\n*Photo vs no photo:*\n${photoLine}` : ''}

*Post types:*
${typeLines}

*Top content tags:*
${tagLines}

*Top hashtags:*
${hashtagLines}

*By source feed:*
${feedLines}

*By day of week:*
${dayLines}

*By time window (ET):*
${windowLines}

*Best post:* [${bestType}] ${bestSnippet}…
_Score: ${fmt(best.score)}${best.impressions ? ` · ${best.impressions.toLocaleString()} impressions` : ''} · ${best.eng} engagements_`;

  console.log('Sending weekly report to Telegram...');
  await sendMessage(message);
  console.log('Weekly report sent.');
}

// Only run when executed directly, not when imported by the scheduler
const isMain = process.argv[1]?.endsWith('fetch-metrics.ts') || process.argv[1]?.endsWith('fetch-metrics.js');
if (isMain) runMetricsFetch().catch(console.error);
