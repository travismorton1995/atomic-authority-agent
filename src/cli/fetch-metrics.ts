import 'dotenv/config';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { sendMessage } from '../hitl/telegram.js';

const USER_DATA_DIR = path.resolve('user_data');
const HISTORY_FILE = 'posted_history.json';

export interface PostMetrics {
  fetchedAt: string;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
}

// Parse a reaction summary aria-label like:
//   "Akkas Mughal and 1 other"       → 2
//   "Name1, Name2 and 3 others"      → 5
//   "Name1 and Name2"                → 2
//   "Name1"                          → 1
function parseReactionLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const othersMatch = label.match(/and (\d+) others?/i);
  if (othersMatch) {
    // Count comma-separated names before "and N others"
    const beforeAnd = label.replace(/\s+and \d+ others?.*$/i, '');
    const namedCount = beforeAnd.split(',').filter(Boolean).length;
    return namedCount + parseInt(othersMatch[1], 10);
  }
  if (/ and /i.test(label)) return 2; // "Name1 and Name2"
  return 1; // single name
}

function parseLeadingNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function scrapeMetrics(url: string): Promise<PostMetrics> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const metrics = await page.evaluate(() => {
      // Reactions: button with data-reaction-details inside the reactions li.
      // aria-label is a name summary like "Akkas Mughal and 1 other" — no plain number.
      const reactionBtn = document.querySelector<HTMLElement>(
        '.social-details-social-counts__reactions button[data-reaction-details]'
      );
      const reactionLabel = reactionBtn?.getAttribute('aria-label') ?? null;

      // Comments: aria-label = "N comments on [name]'s post"
      const commentBtn = document.querySelector<HTMLElement>(
        '.social-details-social-counts__comments button[aria-label]'
      );
      const commentLabel = commentBtn?.getAttribute('aria-label') ?? null;

      // Reposts: aria-label = "N reposts of this post" — element absent when count is 0
      const repostBtn = document.querySelector<HTMLElement>(
        '.social-details-social-counts__reshares button[aria-label],' +
        'button[aria-label*="repost" i]'
      );
      const repostLabel = repostBtn?.getAttribute('aria-label') ?? null;

      return { reactionLabel, commentLabel, repostLabel };
    });

    return {
      fetchedAt: new Date().toISOString(),
      reactions: parseReactionLabel(metrics.reactionLabel),
      comments: parseLeadingNumber(metrics.commentLabel),
      reposts: parseLeadingNumber(metrics.repostLabel),
    };
  } finally {
    await context.close();
  }
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

  for (const post of postsWithUrl) {
    console.log(`\n[${post.draft?.postType}] "${post.draft?.sourceTitle?.slice(0, 60)}"`);
    console.log(`  URL: ${post.linkedInPostUrl}`);
    try {
      const metrics = await scrapeMetrics(post.linkedInPostUrl);
      post.metrics = metrics;
      console.log(`  Reactions: ${metrics.reactions ?? 'n/a'} | Comments: ${metrics.comments ?? 'n/a'} | Reposts: ${metrics.reposts ?? 'n/a'}`);
    } catch (err) {
      console.warn(`  Failed to fetch metrics: ${(err as Error).message}`);
    }
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

  // Attach engagement score to each post
  interface PostWithEng { p: any; eng: number }
  const withEng: PostWithEng[] = posts.map((p: any) => ({
    p,
    eng: (p.metrics?.reactions ?? 0) + (p.metrics?.comments ?? 0) + (p.metrics?.reposts ?? 0),
  }));

  const totalReactions = posts.reduce((s: number, p: any) => s + (p.metrics?.reactions ?? 0), 0);
  const totalComments  = posts.reduce((s: number, p: any) => s + (p.metrics?.comments  ?? 0), 0);
  const totalReposts   = posts.reduce((s: number, p: any) => s + (p.metrics?.reposts   ?? 0), 0);
  const totalEng = totalReactions + totalComments + totalReposts;
  const avgEng   = posts.length > 0 ? (totalEng / posts.length).toFixed(1) : '0';

  // Rank post types by avg engagement
  const typeMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    const t = p.draft?.postType ?? 'unknown';
    const prev = typeMap.get(t) ?? { total: 0, count: 0 };
    typeMap.set(t, { total: prev.total + eng, count: prev.count + 1 });
  }
  const typeRanked = [...typeMap.entries()]
    .map(([type, { total, count }]) => ({ type, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg);

  // Rank content tags by avg engagement
  const tagMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    for (const tag of (p.draft?.contentTags ?? [])) {
      const prev = tagMap.get(tag) ?? { total: 0, count: 0 };
      tagMap.set(tag, { total: prev.total + eng, count: prev.count + 1 });
    }
  }
  const tagRanked = [...tagMap.entries()]
    .map(([tag, { total, count }]) => ({ tag, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  // Rank hashtags by avg engagement
  const hashtagMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    const hashtags = (p.finalContent?.match(/#\w+/g) ?? []).map((t: string) => t.toLowerCase());
    for (const tag of hashtags) {
      const prev = hashtagMap.get(tag) ?? { total: 0, count: 0 };
      hashtagMap.set(tag, { total: prev.total + eng, count: prev.count + 1 });
    }
  }
  const hashtagRanked = [...hashtagMap.entries()]
    .map(([tag, { total, count }]) => ({ tag, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  // Rank source feeds by avg engagement
  const feedMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    const feed = p.draft?.sourceFeed ?? 'Unknown';
    const prev = feedMap.get(feed) ?? { total: 0, count: 0 };
    feedMap.set(feed, { total: prev.total + eng, count: prev.count + 1 });
  }
  const feedRanked = [...feedMap.entries()]
    .map(([feed, { total, count }]) => ({ feed, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg);

  // Rank by day of week (ET)
  const dayMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    const day = new Date(p.publishedAt).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short' });
    const prev = dayMap.get(day) ?? { total: 0, count: 0 };
    dayMap.set(day, { total: prev.total + eng, count: prev.count + 1 });
  }
  const dayRanked = [...dayMap.entries()]
    .map(([day, { total, count }]) => ({ day, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg);

  // Rank by time window (ET)
  function getTimeWindow(iso: string): string {
    const d = new Date(iso);
    const hour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }), 10);
    if (hour >= 7 && hour < 9)   return 'Morning (7–9am)';
    if (hour >= 12 && hour < 13) return 'Noon (12–1pm)';
    if (hour >= 17 && hour < 19) return 'Evening (5–7pm)';
    return 'Other';
  }
  const windowMap = new Map<string, { total: number; count: number }>();
  for (const { p, eng } of withEng) {
    const w = getTimeWindow(p.publishedAt);
    const prev = windowMap.get(w) ?? { total: 0, count: 0 };
    windowMap.set(w, { total: prev.total + eng, count: prev.count + 1 });
  }
  const windowRanked = [...windowMap.entries()]
    .map(([window, { total, count }]) => ({ window, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg);

  // Photo vs no-photo
  const withPhoto    = withEng.filter(({ p }) => !!p.draft?.imageUrl);
  const withoutPhoto = withEng.filter(({ p }) => !p.draft?.imageUrl);
  const photoAvg    = withPhoto.length    ? withPhoto.reduce((s, { eng }) => s + eng, 0)    / withPhoto.length    : null;
  const noPhotoAvg  = withoutPhoto.length ? withoutPhoto.reduce((s, { eng }) => s + eng, 0) / withoutPhoto.length : null;

  // Best individual post
  const best = [...withEng].sort((a, b) => b.eng - a.eng)[0];
  const bestSnippet = best.p.finalContent?.split('\n')[0]?.slice(0, 80) ?? '';
  const bestType = best.p.draft?.postType ?? 'unknown';

  const medals = ['🥇', '🥈', '🥉'];
  const fmt = (n: number) => n.toFixed(1);

  const dateStart = new Date(cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });
  const dateEnd   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });

  const typeLines = typeRanked.map((t, i) =>
    `${medals[i] ?? '  •'} \`${t.type}\` — avg ${fmt(t.avg)} eng (${t.count} post${t.count !== 1 ? 's' : ''})`
  ).join('\n');

  const tagLines = tagRanked.length > 0
    ? tagRanked.map((t, i) => `  ${i + 1}\\. \`${t.tag}\` — avg ${fmt(t.avg)} eng`).join('\n')
    : '  _(no tags)_';

  const feedLines = feedRanked.map((f, i) =>
    `${medals[i] ?? '  •'} ${f.feed} — avg ${fmt(f.avg)} eng`
  ).join('\n');

  const hashtagLines = hashtagRanked.length > 0
    ? hashtagRanked.map((t, i) => `  ${i + 1}\\. \`${t.tag}\` — avg ${fmt(t.avg)} eng (${t.count} post${t.count !== 1 ? 's' : ''})`).join('\n')
    : '  _(no hashtags found)_';

  const dayLines = dayRanked.map((d, i) =>
    `${medals[i] ?? '  •'} ${d.day} — avg ${fmt(d.avg)} eng (${d.count} post${d.count !== 1 ? 's' : ''})`
  ).join('\n');

  const windowLines = windowRanked.map((w, i) =>
    `${medals[i] ?? '  •'} ${w.window} — avg ${fmt(w.avg)} eng (${w.count} post${w.count !== 1 ? 's' : ''})`
  ).join('\n');

  const photoLine = [
    withPhoto.length    ? `📷 with photo (${withPhoto.length}): avg ${fmt(photoAvg!)} eng`       : null,
    withoutPhoto.length ? `🚫 no photo (${withoutPhoto.length}): avg ${fmt(noPhotoAvg!)} eng` : null,
  ].filter(Boolean).join(' | ');

  const message =
`📊 *Monthly Report* (${dateStart}–${dateEnd})

*Posts published:* ${posts.length}
*Reactions:* ${totalReactions} | *Comments:* ${totalComments} | *Reposts:* ${totalReposts}
*Avg engagement/post:* ${avgEng}
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
_${best.eng} total engagement_`;

  console.log('Sending weekly report to Telegram...');
  await sendMessage(message);
  console.log('Weekly report sent.');
}

// Only run when executed directly, not when imported by the scheduler
const isMain = process.argv[1]?.endsWith('fetch-metrics.ts') || process.argv[1]?.endsWith('fetch-metrics.js');
if (isMain) runMetricsFetch().catch(console.error);
