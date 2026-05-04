// Scrapes inline impression and reaction counts for our outbound comments.
// LinkedIn shows these metrics directly on comments when you view the post.
// Only scrapes comments on other people's posts (self-post comments are excluded
// because those followers are already attributed to the parent post's own metrics).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Page } from 'playwright';
import type { PendingComment } from './outbound-queue.js';

const STATE_FILE = 'outbound_state.json';
const HISTORY_FILE = 'posted_history.json';
const COMMENT_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000; // 15 days — matches attribution snapshot window
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // re-scrape after 24 hours

// LinkedIn profile URL slug used to identify our own comments in the DOM.
// Falls back to text matching if not set.
const OUR_PROFILE_SLUG = process.env.LINKEDIN_PROFILE_URL
  ?.replace(/\/$/, '')          // strip trailing slash
  ?.split('/').pop()            // "travisbmorton"
  ?? '';

interface OutboundState {
  seenPostIds: string[];
  pendingComments: PendingComment[];
  lastPollAt: string | null;
  dailyCount: { date: string; count: number };
  fallbackCandidate: any;
}

/** Load the set of our own LinkedIn post URLs for self-post exclusion. */
function loadOwnPostUrls(): Set<string> {
  const urls = new Set<string>();
  if (!existsSync(HISTORY_FILE)) return urls;
  try {
    const posts: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    for (const p of posts) {
      if (p.linkedInPostUrl) urls.add(p.linkedInPostUrl);
    }
  } catch { /* graceful degradation */ }
  return urls;
}

/** Get comments eligible for metrics scraping: posted, within lookback, not on own posts, stale or missing metrics. */
function getScrapableComments(state: OutboundState): PendingComment[] {
  const cutoff = Date.now() - COMMENT_LOOKBACK_MS;
  const ownPostUrls = loadOwnPostUrls();
  const now = Date.now();

  return state.pendingComments.filter(c => {
    if (c.status !== 'posted' || !c.postedAt) return false;
    if (new Date(c.postedAt).getTime() < cutoff) return false;
    if (ownPostUrls.has(c.postUrl)) return false;
    // Skip if recently scraped
    if (c.metricsScrapedAt && (now - new Date(c.metricsScrapedAt).getTime()) < STALE_THRESHOLD_MS) return false;
    return true;
  });
}

interface CommentMetrics {
  impressions: number | null;
  reactions: number | null;
}

/**
 * Scrape inline impressions and reactions for our comments on a single LinkedIn post page.
 *
 * DOM structure (verified 2026-04-17):
 *   article.comments-comment-entity
 *     ├─ .comments-comment-meta__container
 *     │    └─ a[href="/in/{slug}"]              ← identifies commenter
 *     ├─ .comments-comment-item__main-content   ← comment text
 *     └─ .comments-comment-social-bar--cr
 *          └─ .comments-comment-social-bar__impressions-count  ← "7 impressions"
 *
 * We identify our comments by matching our profile slug in the commenter link href,
 * then extract impressions from the social bar. Much more reliable than text matching.
 */
async function scrapeCommentsOnPost(page: Page, postUrl: string): Promise<CommentMetrics[]> {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for SPA hydration so comment data is in the DOM
    await page.waitForSelector(
      'article, main [class*="feed-shared"], div[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:ugcPost:"]',
      { timeout: 20000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Switch sort to "Most recent" — LinkedIn redesigned this control
    const sortBtn = page.locator(
      'button[aria-label*="Sort comments"], button.comments-sort-dropdown__trigger-text-wrapper, .comments-sort-order-toggle__trigger'
    ).first();
    if (await sortBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sortBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      const recentOpt = page.locator('div[role="menuitem"], li[role="menuitem"], li[role="option"], button')
        .filter({ hasText: /^Most recent$/i }).first();
      if (await recentOpt.isVisible({ timeout: 1500 }).catch(() => false)) {
        await recentOpt.click().catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    // Load more comments (multiple selector variants for the new UI)
    for (let i = 0; i < 5; i++) {
      const btn = page.locator(
        'button[aria-label*="Load more comments"], ' +
        'button[aria-label*="Show more comments"], ' +
        'button[aria-label*="Show previous comments"], ' +
        '.comments-comments-list__load-more-comments-button--cr'
      ).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1500);
      } else {
        break;
      }
    }

    // Text-based extraction. LinkedIn (May 2026) stripped comment article
    // tags and class names. Identify OUR comments by display name match,
    // then scan each block for "X impressions" and reaction count.
    const myDisplayName = process.env.LINKEDIN_DISPLAY_NAME ?? '';
    const results = await page.evaluate((displayName) => {
      // Get text scoped to AFTER the comment composer (skips post body)
      let scopedText = '';
      const editor = document.querySelector('[aria-label="Text editor for creating comment"]')
        || document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
      if (editor) {
        const range = document.createRange();
        range.setStartAfter(editor);
        range.setEndAfter(document.body);
        const frag = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(frag);
        document.body.appendChild(div);
        scopedText = (div as HTMLElement).innerText ?? '';
        div.remove();
      } else {
        scopedText = document.body?.innerText ?? '';
      }
      const lines = scopedText.split('\n');

      // Boundary detection — same approach as monitor-replies
      const rawBoundaries: { idx: number; reason: string }[] = [];
      const nameLower = displayName.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^[·•]\s*(1st|2nd|3rd\+?)$/i.test(t)) { rawBoundaries.push({ idx: i, reason: 'degree' }); continue; }
        if (/^Author$/.test(t)) { rawBoundaries.push({ idx: i, reason: 'author' }); continue; }
        // Inline format: "Name • 2nd" — name + degree on same line
        if (/[A-Za-z][^\n]*?(\s[·•]\s*|\s{2,})(1st|2nd|3rd\+?)$/i.test(t) && t.length < 120) {
          rawBoundaries.push({ idx: i, reason: 'degree-inline' });
          continue;
        }
        if (nameLower && t.length > 0 && t.length < 80) {
          const tLower = t.toLowerCase();
          if (tLower === nameLower) { rawBoundaries.push({ idx: i, reason: 'self' }); continue; }
          if (tLower.includes(nameLower) && /\bYou\b/.test(t)) { rawBoundaries.push({ idx: i, reason: 'self-you' }); continue; }
        }
      }
      // Filter spurious self matches (quotes inside other comments)
      const TIMESTAMP_PROBE = /^(now|just now|\d+\s*(yr|mo|w|wk|d|h|m|s|sec|min|hr|day|week|month|year)s?)$/i;
      const filteredBoundaries: { idx: number; reason: string }[] = [];
      for (const b of rawBoundaries) {
        if (b.reason === 'degree' || b.reason === 'degree-inline' || b.reason === 'author') {
          filteredBoundaries.push(b);
          continue;
        }
        let validHeader = false;
        for (let j = b.idx + 1; j < Math.min(b.idx + 7, lines.length); j++) {
          const l = lines[j].trim();
          if (!l) continue;
          if (/^Author$/.test(l)) { validHeader = true; break; }
          if (/^Follow(ing)?$/i.test(l)) { validHeader = true; break; }
          if (TIMESTAMP_PROBE.test(l)) { validHeader = true; break; }
          if (TIMESTAMP_PROBE.test(l.replace(/\(?\s*edited\s*\)?/gi, '').replace(/\s*[·•]\s*/g, ' ').trim())) { validHeader = true; break; }
        }
        if (validHeader) filteredBoundaries.push(b);
      }
      const boundaries: { idx: number; reason: string }[] = [];
      for (const b of filteredBoundaries) {
        const last = boundaries[boundaries.length - 1];
        if (last && b.idx - last.idx <= 4) continue;
        boundaries.push(b);
      }

      const found: Array<{ impressions: number | null; reactions: number | null }> = [];

      // Only process OUR own comments
      for (let bi = 0; bi < boundaries.length; bi++) {
        const { idx: boundary, reason } = boundaries[bi];
        if (reason !== 'self' && reason !== 'self-you') continue;
        const nextBoundary = boundaries[bi + 1]?.idx ?? lines.length;

        let impressions: number | null = null;
        let reactions: number | null = null;
        let sawActionBar = false;

        for (let j = boundary + 1; j < nextBoundary; j++) {
          const l = lines[j].trim();
          // Stop at footer
          if (/^About$/.test(l) || /^Accessibility$/.test(l) || /^Help Center$/.test(l)) break;
          if (/^LinkedIn Corporation/.test(l)) break;
          if (/^©/.test(l)) break;
          // "X impressions" — capture the count
          const impMatch = l.match(/^(\d+(?:,\d+)*)\s*impressions?$/i);
          if (impMatch) {
            impressions = parseInt(impMatch[1].replace(/,/g, ''), 10);
            continue;
          }
          // Action bar markers
          if (/^Like$/i.test(l) || /^Reply$/i.test(l) || /^Like\s*[·•]?\s*Reply/i.test(l)) {
            sawActionBar = true;
            continue;
          }
          // Reaction count: standalone small number AFTER action bar but
          // BEFORE impressions (LinkedIn shows: "Like\nReply\n3\n5 impressions")
          if (sawActionBar && reactions === null && /^\d{1,4}$/.test(l)) {
            reactions = parseInt(l, 10);
            continue;
          }
        }
        found.push({ impressions, reactions });
      }
      return found;
    }, myDisplayName);

    return results;
  } catch (err) {
    console.warn(`  [comment-metrics] Failed to load post ${postUrl}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Scrape metrics for all eligible outbound comments. Called by the midnight snapshot.
 * Groups comments by post URL to minimize page navigations.
 */
export async function scrapeCommentMetrics(page: Page): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    console.log('[comment-metrics] No outbound_state.json found.');
    return;
  }

  if (!OUR_PROFILE_SLUG) {
    console.warn('[comment-metrics] LINKEDIN_PROFILE_URL not set — cannot identify our comments. Skipping.');
    return;
  }

  const state: OutboundState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  const scrapable = getScrapableComments(state);

  if (scrapable.length === 0) {
    console.log('[comment-metrics] No comments to scrape.');
    return;
  }

  console.log(`[comment-metrics] Scraping metrics for ${scrapable.length} comment(s) (profile: ${OUR_PROFILE_SLUG})...`);

  // Group by post URL to minimize navigations
  const byPostUrl = new Map<string, PendingComment[]>();
  for (const c of scrapable) {
    if (!byPostUrl.has(c.postUrl)) byPostUrl.set(c.postUrl, []);
    byPostUrl.get(c.postUrl)!.push(c);
  }

  let updated = 0;
  let consecutiveFailures = 0;
  const CIRCUIT_BREAKER_LIMIT = 3;

  for (const [postUrl, comments] of byPostUrl) {
    console.log(`  [comment-metrics] Checking ${postUrl} (${comments.length} comment(s))...`);
    const scraped = await scrapeCommentsOnPost(page, postUrl);

    if (scraped.length === 0 && comments.length > 0) {
      consecutiveFailures++;
      console.warn(`    No comments by us found on page (${consecutiveFailures} consecutive failures)`);
      if (consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
        console.error(`[comment-metrics] ${CIRCUIT_BREAKER_LIMIT} consecutive failures — circuit breaker tripped. Aborting.`);
        break;
      }
      continue;
    }

    consecutiveFailures = 0;

    // Match scraped results to our comment records.
    // We typically have 1 comment per post. If multiple, match by order (oldest first).
    const sortedComments = [...comments].sort((a, b) =>
      new Date(a.postedAt!).getTime() - new Date(b.postedAt!).getTime()
    );

    for (let i = 0; i < sortedComments.length && i < scraped.length; i++) {
      const m = scraped[i];
      const stateComment = state.pendingComments.find(sc => sc.id === sortedComments[i].id);
      if (!stateComment) continue;

      if (m.impressions !== null) stateComment.commentImpressions = m.impressions;
      if (m.reactions !== null) stateComment.commentReactions = m.reactions;
      stateComment.metricsScrapedAt = new Date().toISOString();
      updated++;
      console.log(`    ${sortedComments[i].profileName}: ${m.impressions ?? 'n/a'} impressions, ${m.reactions ?? 'n/a'} reactions`);
    }
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[comment-metrics] Updated ${updated}/${scrapable.length} comment(s).`);
}
