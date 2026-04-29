// Outbound comment reply monitoring.
// Scrapes posts where we left outbound comments (within 3-day window),
// finds replies to our comment thread, and generates response options.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import path from 'path';
import { acquireBrowserLock } from '../poster/browser-lock.js';
import { isSessionExpiredUrl } from '../poster/index.js';
import { generateReplies } from '../content/reply.js';
import { fetchArticle } from '../content/fetch-article.js';
import { addPendingReply, isCommentSeen, markCommentSeen } from '../hitl/comment-queue.js';
import { notifyCommentReply } from '../hitl/telegram.js';
import type { PendingComment } from './outbound-queue.js';

const STATE_FILE = 'outbound_state.json';
const USER_DATA_DIR = path.resolve('user_data');
const MONITOR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface ScrapedComment {
  id: string;
  author: string;
  text: string;
  isReply: boolean;
}

/** Load posted outbound comments within the monitoring window. */
function getMonitorableComments(): PendingComment[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const cutoff = Date.now() - MONITOR_WINDOW_MS;
    return (state.pendingComments ?? []).filter((c: PendingComment) =>
      c.status === 'posted' &&
      c.postedAt &&
      new Date(c.postedAt).getTime() >= cutoff
    );
  } catch { return []; }
}

/** Scrape comments from a post using an existing page (no browser lock needed). */
async function scrapeCommentsWithPage(page: import('playwright').Page, postUrl: string): Promise<ScrapedComment[]> {
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Expand comments section
  const expandBtn = page.locator('button[aria-label*="comment on"]').first();
  if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await expandBtn.click();
    await page.waitForTimeout(2000);
  }

  // Load more comments if paginated
  for (let i = 0; i < 10; i++) {
    const btn = page.locator('button[aria-label*="Load more comments"]').first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1000);
    } else {
      break;
    }
  }

  // Expand reply threads — match both "reply" (singular) and "replies" (plural)
  const replyExpandBtns = page.locator('button[aria-label*="repl"]');
  const expandCount = await replyExpandBtns.count();
  for (let i = 0; i < expandCount; i++) {
    await replyExpandBtns.nth(i).click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const rawComments = await page.evaluate(() => {
    const items = document.querySelectorAll<HTMLElement>('article[data-id^="urn:li:comment:"]');
    return Array.from(items).map(item => {
      const dataId = item.getAttribute('data-id') ?? '';
      const isReply = dataId.includes('urn:li:comment:(comment:');
      const author = (
        item.querySelector('.comments-comment-meta__description-title')?.textContent ??
        item.querySelector('.comments-comment-meta__data')?.textContent ??
        'Unknown'
      ).trim();
      const text = (
        item.querySelector('.comments-comment-item__main-content')?.textContent ??
        item.querySelector('.comments-comment-entity__content')?.textContent ??
        ''
      ).trim();
      return { dataId, author, text, isReply };
    }).filter(c => c.text.length > 0);
  });

  return rawComments.map(c => ({
    id: c.dataId,
    author: c.author,
    text: c.text,
    isReply: c.isReply,
  }));
}

/** Scrape full post text from the page (already navigated). */
async function scrapePostText(page: import('playwright').Page): Promise<string> {
  // Click "see more" if present to get full text
  const seeMore = page.locator('button[aria-label*="see more"], button.feed-shared-inline-show-more-text').first();
  if (await seeMore.isVisible({ timeout: 1000 }).catch(() => false)) {
    await seeMore.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const text = await page.evaluate(() => {
    const el = document.querySelector(
      '.update-components-text, ' +
      '.feed-shared-update-v2__description .feed-shared-inline-show-more-text, ' +
      '.feed-shared-text'
    );
    return el?.textContent?.trim() ?? '';
  });
  return text;
}

/**
 * Extract the thread between us and any repliers on our specific comment.
 * Returns: our comment + direct replies to it (ordered by appearance).
 *
 * LinkedIn has two reply styles in the DOM:
 * 1. Nested replies: isReply=true, appear sequentially after the parent comment
 * 2. Top-level replies: isReply=false but appear right after our comment
 *    (LinkedIn sometimes renders visual replies as top-level DOM elements)
 *
 * We capture both: nested replies via isReply flag, and the first top-level
 * comment after ours if it's from someone else (likely a direct response).
 * We also scan all comments for ones that mention our name in the text.
 */
function extractOurThread(
  allComments: ScrapedComment[],
  myName: string,
): { ourComment: ScrapedComment | null; thread: ScrapedComment[] } {
  const myNameLower = myName.toLowerCase();
  // Find our comment — could be top-level or a reply
  const ourComment = allComments.find(c =>
    c.author.toLowerCase().includes(myNameLower)
  );
  if (!ourComment) return { ourComment: null, thread: [] };

  const ourIdx = allComments.indexOf(ourComment);
  const thread: ScrapedComment[] = [];
  const seen = new Set<string>();

  // 1. Collect nested replies (isReply=true) immediately after our comment
  for (let i = ourIdx + 1; i < allComments.length; i++) {
    const c = allComments[i];
    if (!c.isReply) break;
    if (!c.author.toLowerCase().includes(myNameLower)) {
      thread.push(c);
      seen.add(c.id);
    }
  }

  // 2. Scan all comments after ours for ones that mention our first name
  //    (LinkedIn top-level "replies" that visually nest but aren't nested in DOM)
  const firstName = myName.split(/[\s,]/)[0].toLowerCase();
  for (let i = ourIdx + 1; i < allComments.length; i++) {
    const c = allComments[i];
    if (seen.has(c.id)) continue;
    if (c.author.toLowerCase().includes(myNameLower)) continue; // skip our own
    if (c.text.toLowerCase().includes(firstName)) {
      thread.push(c);
      seen.add(c.id);
    }
  }

  return { ourComment, thread };
}

export interface OutboundMonitorStats {
  postsChecked: number;
  newReplies: number;
}

/**
 * Monitor outbound comments for replies. Checks all posted comments within
 * the 3-day window, scrapes their threads, and generates reply options for
 * new responses.
 */
export async function runOutboundReplyMonitor(): Promise<OutboundMonitorStats> {
  const monitorable = getMonitorableComments();
  if (monitorable.length === 0) return { postsChecked: 0, newReplies: 0 };

  const myName = (process.env.LINKEDIN_DISPLAY_NAME ?? '').toLowerCase();
  if (!myName) {
    console.warn('[outbound-monitor] LINKEDIN_DISPLAY_NAME not set — cannot identify our comments.');
    return { postsChecked: 0, newReplies: 0 };
  }

  // Deduplicate by post URL (we might have commented on the same post twice)
  const byPost = new Map<string, PendingComment[]>();
  for (const c of monitorable) {
    const existing = byPost.get(c.postUrl) ?? [];
    existing.push(c);
    byPost.set(c.postUrl, existing);
  }

  console.log(`[outbound-monitor] Checking ${byPost.size} post(s) for replies to ${monitorable.length} comment(s)...`);

  interface ScrapedPostData {
    comments: PendingComment[];
    allComments: ScrapedComment[];
    fullPostText: string;
    articleLinkHref: string;
    dateLabel: string;
  }
  const scrapedPosts: ScrapedPostData[] = [];
  let postsChecked = 0;
  let newReplies = 0;

  // --- Browser phase: scrape all posts, then release the lock ---
  const release = await acquireBrowserLock(60_000);
  try {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: process.env.LINKEDIN_HEADLESS === 'true',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    const page = context.pages()[0] ?? await context.newPage();

    // Session check
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (isSessionExpiredUrl(page.url())) {
      console.error('[outbound-monitor] LinkedIn session expired.');
      await context.close();
      return { postsChecked: 0, newReplies: 0 };
    }

    try {
      for (const [postUrl, comments] of byPost) {
        const postedAt = comments[0].postedAt ? new Date(comments[0].postedAt) : null;
        const dateLabel = postedAt
          ? postedAt.toLocaleString('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : '?';

        let allComments: ScrapedComment[];
        let fullPostText: string;
        try {
          allComments = await scrapeCommentsWithPage(page, postUrl);
          fullPostText = await scrapePostText(page);
        } catch (err) {
          console.warn(`  [outbound-monitor] ${comments[0].profileName} (${dateLabel}): failed to scrape — ${(err as Error).message}`);
          continue;
        }

        const articleLinkHref = await page.evaluate(() => {
          const link = document.querySelector(
            'a.feed-shared-article__meta, ' +
            'a[data-tracking-control-name="feed-type-content"], ' +
            '.feed-shared-article a[href], ' +
            '.update-components-article a[href]'
          );
          const href = link?.getAttribute('href') ?? '';
          return href.startsWith('http') && !href.includes('linkedin.com') ? href : '';
        }).catch(() => '');

        scrapedPosts.push({ comments, allComments, fullPostText, articleLinkHref, dateLabel });
      }
    } finally {
      await context.close();
    }
  } catch (err) {
    console.error(`[outbound-monitor] Browser phase failed: ${(err as Error).message}`);
  } finally {
    release();
  }

  // Processing phase — no browser needed, lock is released
  for (const { comments, allComments, fullPostText, articleLinkHref, dateLabel } of scrapedPosts) {
    postsChecked++;

    const { ourComment, thread } = extractOurThread(allComments, myName);
    if (!ourComment) {
      console.log(`  [outbound-monitor] ${comments[0].profileName} (${dateLabel}): our comment not found on page`);
      continue;
    }

    const newThreadReplies = thread.filter(c =>
      !c.author.toLowerCase().includes(myName) && !isCommentSeen(c.id)
    );

    if (newThreadReplies.length === 0) {
      console.log(`  [outbound-monitor] ${comments[0].profileName} (${dateLabel}): ${thread.length} reply(ies) in thread, 0 new`);
      continue;
    }

    console.log(`  [outbound-monitor] ${comments[0].profileName} (${dateLabel}): ${newThreadReplies.length} new reply(ies) in thread`);

    let articleText: string | undefined;
    let articleTitle: string | undefined;
    if (articleLinkHref) {
      try {
        const article = await fetchArticle(articleLinkHref);
        if (article.fullText && article.fullText.length > 100) {
          const words = article.fullText.split(/\s+/);
          articleText = words.length > 1500 ? words.slice(0, 1500).join(' ') + ' [truncated]' : article.fullText;
          articleTitle = article.title;
        }
      } catch { /* non-fatal */ }
    }

    const threadContext = [
      { author: 'You (Travis)', text: ourComment.text },
      ...thread.map(c => ({
        author: c.author.toLowerCase().includes(myName) ? 'You (Travis)' : c.author,
        text: c.text,
      })),
    ];

    for (const reply of newThreadReplies) {
      markCommentSeen(reply.id);

      try {
        const generated = await generateReplies(
          {
            content: fullPostText,
            postType: 'outbound',
            authorName: comments[0].profileName,
            articleTitle,
            articleText,
          },
          { author: reply.author, text: reply.text },
          threadContext,
        );

        const pendingReply = {
          id: `obr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          postUrl: comments[0].postUrl,
          postType: 'outbound',
          postSnippet: fullPostText.split('\n')[0]?.slice(0, 80) ?? comments[0].postSnippet,
          commentId: reply.id,
          commentAuthor: reply.author,
          commentText: reply.text,
          commentType: generated.commentType,
          isReply: true,
          replyOptions: [generated.options[0].text, generated.options[1].text, generated.options[2].text] as [string, string, string],
          replyLabels: [generated.options[0].label, generated.options[1].label, generated.options[2].label] as [string, string, string],
          recommendationReason: generated.recommendationReason,
          reasoning: generated.reasoning,
          status: 'pending' as const,
          createdAt: new Date().toISOString(),
        };

        addPendingReply(pendingReply);
        await notifyCommentReply(pendingReply);
        newReplies++;
        console.log(`  [outbound-monitor] Reply from ${reply.author} — options generated`);
      } catch (err) {
        console.warn(`  [outbound-monitor] Failed to generate reply for ${reply.author}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`[outbound-monitor] Done. ${postsChecked} post(s) checked, ${newReplies} new reply(ies) queued.`);
  return { postsChecked, newReplies };
}
