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
    await page.waitForTimeout(3000);

    // Switch from "Most relevant" to "Most recent" so all comments are visible
    try {
      const sortToggle = page.locator('.comments-sort-order-toggle__trigger').first();
      if (await sortToggle.isVisible({ timeout: 2000 })) {
        const currentSort = await sortToggle.textContent();
        if (currentSort?.includes('Most relevant')) {
          await sortToggle.click();
          await page.waitForTimeout(500);
          // LinkedIn dropdown: li[role="option"] with "Most recent" text
          const recentOpt = page.locator('li[role="option"]').filter({ hasText: 'Most recent' }).first();
          if (await recentOpt.isVisible({ timeout: 1000 })) {
            await recentOpt.click();
            await page.waitForTimeout(2000);
          }
        }
      }
    } catch { /* couldn't switch sort — proceed with what's visible */ }

    // Click "Load more comments" repeatedly to expand all comments
    try {
      for (let i = 0; i < 5; i++) {
        const loadMoreBtn = page.locator('.comments-comments-list__load-more-comments-button--cr').first();
        if (await loadMoreBtn.isVisible({ timeout: 1000 })) {
          await loadMoreBtn.click();
          await page.waitForTimeout(1500);
        } else {
          break;
        }
      }
    } catch { /* no more comments to load */ }

    // Find all our comments on this post by profile URL match
    const results = await page.evaluate((profileSlug: string) => {
      const commentEls = document.querySelectorAll('article.comments-comment-entity');
      const found: Array<{ impressions: number | null; reactions: number | null }> = [];

      for (const el of commentEls) {
        // Check if this comment is ours by matching profile link
        const profileLink = el.querySelector('a.comments-comment-meta__image-link, a.comments-comment-meta__description-container');
        const href = profileLink?.getAttribute('href') ?? '';
        if (!profileSlug || !href.includes(`/in/${profileSlug}`)) continue;

        // This is our comment — extract impressions
        let impressions: number | null = null;
        let reactions: number | null = null;

        // Impressions: .comments-comment-social-bar__impressions-count contains "7 impressions"
        const impressionsEl = el.querySelector('.comments-comment-social-bar__impressions-count');
        if (impressionsEl) {
          const match = impressionsEl.textContent?.replace(/,/g, '').match(/(\d+)/);
          if (match) impressions = parseInt(match[1], 10);
        }

        // Reactions: look for a count near the Like button or a reactions summary
        // When a comment has reactions, LinkedIn shows a count (e.g., "3" or "3 reactions")
        const socialBar = el.querySelector('[class*="comments-comment-social-bar"]');
        if (socialBar) {
          // Check for a reaction count button/span (appears when others react)
          const reactionEl = socialBar.querySelector(
            'button[aria-label*="reaction"], span[class*="reaction-count"], .social-details-social-counts'
          );
          if (reactionEl) {
            const match = reactionEl.textContent?.replace(/,/g, '').match(/(\d+)/);
            if (match) reactions = parseInt(match[1], 10);
          }
        }

        found.push({ impressions, reactions });
      }

      return found;
    }, OUR_PROFILE_SLUG);

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

  for (const [postUrl, comments] of byPostUrl) {
    console.log(`  [comment-metrics] Checking ${postUrl} (${comments.length} comment(s))...`);
    const scraped = await scrapeCommentsOnPost(page, postUrl);

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

    if (scraped.length === 0 && comments.length > 0) {
      console.warn(`    No comments by us found on page (comment may be hidden by sort order)`);
    }
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[comment-metrics] Updated ${updated}/${scrapable.length} comment(s).`);
}
