// Outbound comment reply monitoring.
// Scrapes posts where we left outbound comments (within 3-day window),
// finds replies to our comment thread, and generates response options.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';
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
  // Wait for the post article to lazy-load. domcontentloaded fires before
  // LinkedIn finishes hydrating the SPA, so without this wait the page only
  // contains nav/sidebar chrome and articleCount stays at 0.
  await page.waitForSelector('article, main [class*="feed-shared"], div[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:ugcPost:"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Expand comments section
  const expandBtn = page.locator('button[aria-label*="comment on"]').first();
  if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await expandBtn.click();
    await page.waitForTimeout(2000);
  }

  // Switch sort to "Most recent" so our (often low-engagement) comments
  // surface above the fold instead of being buried by "Most relevant".
  const sortBtn = page.locator(
    'button[aria-label*="Sort comments"], button.comments-sort-dropdown__trigger-text-wrapper'
  ).first();
  if (await sortBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sortBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    const recentOption = page.locator('div[role="menuitem"], li[role="menuitem"], button')
      .filter({ hasText: /^Most recent$/i }).first();
    if (await recentOption.isVisible({ timeout: 1500 }).catch(() => false)) {
      await recentOption.click().catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      // Close the menu to avoid intercepting later clicks
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // Load more comments if paginated. LinkedIn uses several variants:
  // "Load more comments", "Show more comments", "Show previous comments"
  for (let i = 0; i < 10; i++) {
    const btn = page.locator(
      'button[aria-label*="Load more comments"], ' +
      'button[aria-label*="Show more comments"], ' +
      'button[aria-label*="Show previous comments"]'
    ).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1200);
    } else {
      break;
    }
  }

  // Expand reply threads. LinkedIn uses several button label variants:
  //   "Show 3 replies", "See previous replies", "See more replies"
  // Buttons may not have aria-labels in the new UI, so we use getByText
  // which matches text content on any element type.
  for (let pass = 0; pass < 5; pass++) {
    let clicked = 0;
    // 1. aria-label variants (older buttons)
    const ariaBtns = page.locator(
      'button[aria-label*="repl" i], button[aria-label*="See previous" i], button[aria-label*="See more" i]'
    );
    const ariaCount = await ariaBtns.count();
    for (let i = 0; i < ariaCount; i++) {
      if (await ariaBtns.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
        await ariaBtns.nth(i).click().catch(() => {});
        await page.waitForTimeout(700);
        clicked++;
      }
    }
    // 2. Text-content variants — getByText matches ANY element by accessible text
    for (const re of [
      /^See previous repl(y|ies)$/i,
      /^See more repl(y|ies)$/i,
      /^Show \d+ (more )?repl(y|ies)$/i,
    ]) {
      const targets = page.getByText(re);
      const count = await targets.count();
      for (let i = 0; i < count; i++) {
        if (await targets.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
          await targets.nth(i).click().catch(() => {});
          await page.waitForTimeout(700);
          clicked++;
        }
      }
    }
    if (clicked === 0) break;
  }

  // Parse comments from rendered text. LinkedIn (May 2026) stripped all
  // structural attributes from comments (no <article>, no data-id, no
  // data-urn, no semantic classes — just obfuscated CSS-module hashes).
  // We anchor on the comment composer (which DOES have a stable aria-label),
  // take the text AFTER it (= comments only, excluding the post body),
  // and identify each commenter via:
  //   1) Standalone "· 1st" / "· 2nd" / "· 3rd+" / "Author" badge lines
  //   2) Lines matching our display name (our own comment lacks degree)
  // After each boundary, content begins after the timestamp marker —
  // everything before that is metadata (subtitle, badge, "Follow" button).
  const myDisplayName = process.env.LINKEDIN_DISPLAY_NAME ?? '';
  const rawComments = await page.evaluate((displayName) => {
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

    // Boundary detection
    const rawBoundaries: { idx: number; reason: string }[] = [];
    const nameLower = displayName.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      // Standalone degree marker on its own line: "· 1st" / "• 2nd"
      if (/^[·•]\s*(1st|2nd|3rd\+?)$/i.test(t)) { rawBoundaries.push({ idx: i, reason: 'degree' }); continue; }
      if (/^Author$/.test(t)) { rawBoundaries.push({ idx: i, reason: 'author' }); continue; }
      // Inline format: "Name • 2nd" or "Name  2nd" (name + degree on same line)
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
    // Filter out spurious "self" matches that are quotes inside another
    // commenter's text. A real boundary is followed within a few lines by
    // an "Author" tag, "Follow" button, subtitle, or timestamp marker.
    const TIMESTAMP_PROBE = /^(now|just now|\d+\s*(yr|mo|w|wk|d|h|m|s|sec|min|hr|day|week|month|year)s?)$/i;
    const filteredBoundaries: { idx: number; reason: string }[] = [];
    for (const b of rawBoundaries) {
      if (b.reason === 'degree' || b.reason === 'degree-inline' || b.reason === 'author') {
        filteredBoundaries.push(b);
        continue;
      }
      // Self/self-you: verify by looking ahead for header signals
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
    // Dedupe boundaries within 4 lines (LinkedIn renders name twice — header + avatar)
    const boundaries: { idx: number; reason: string }[] = [];
    for (const b of filteredBoundaries) {
      const last = boundaries[boundaries.length - 1];
      if (last && b.idx - last.idx <= 4) continue;
      boundaries.push(b);
    }

    interface Parsed { id: string; author: string; text: string; isReply: boolean }
    const comments: Parsed[] = [];
    const TIMESTAMP_RE = /^(now|just now|\d+\s*(yr|mo|w|wk|d|h|m|s|sec|min|hr|day|week|month|year)s?)$/i;

    for (let bi = 0; bi < boundaries.length; bi++) {
      const { idx: boundary, reason } = boundaries[bi];
      const nextBoundary = boundaries[bi + 1]?.idx ?? lines.length;
      let rawAuthor = '';
      if (reason === 'self' || reason === 'self-you' || reason === 'degree-inline') {
        // For inline format ("Name • 2nd"), the boundary line itself contains
        // the name + degree — author cleanup will strip the degree below.
        rawAuthor = lines[boundary];
      } else {
        for (let j = boundary - 1; j >= Math.max(0, boundary - 4); j--) {
          const l = lines[j].trim();
          if (!l) continue;
          if (/^(Premium Profile|Influencer|Author|Following|Verified Profile)$/i.test(l)) continue;
          rawAuthor = l;
          break;
        }
      }
      // Strip LinkedIn badge tokens. Inlined to avoid TS helper functions
      // that fail inside page.evaluate browser context.
      const author = rawAuthor
        .replace(/\bVerified Profile\b/gi, '')
        .replace(/\bPremium Profile\b/gi, '')
        .replace(/\bInfluencer\b/gi, '')
        .replace(/\bFollowing\b/gi, '')
        .replace(/\bAuthor\b/g, '')
        .replace(/\bYou\b/g, '')
        .replace(/\s*[·•]\s*(1st|2nd|3rd\+?)\s*$/gi, '')
        .replace(/\s*(1st|2nd|3rd\+?)\s*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!author) continue;

      // Comment text: enter content mode only AFTER seeing a timestamp line.
      // Everything before the timestamp is metadata.
      const textLines: string[] = [];
      let inContent = false;
      let sawAnyContent = false;
      for (let j = boundary + 1; j < nextBoundary; j++) {
        const l = lines[j].trim();
        if (/^Like$/i.test(l)) break;
        if (/^Reply$/i.test(l)) break;
        if (/^Like\s*[·•]?\s*Reply/i.test(l)) break;
        if (/^\d+\s*reactions?$/i.test(l)) break;
        if (/^\d+\s*repl(y|ies)$/i.test(l)) break;
        if (/^Show\s+\d+\s+(more\s+)?(reply|replies|comments)/i.test(l)) break;
        if (/^See (previous|more) repl(y|ies)$/i.test(l)) break;
        if (/^Load more comments?$/i.test(l)) break;
        if (/^\d+\s*impressions?$/i.test(l)) break;
        if (/^About$/.test(l) || /^Accessibility$/.test(l) || /^Help Center$/.test(l)) break;
        if (/^LinkedIn Corporation/.test(l)) break;
        if (/^©/.test(l)) break;
        if (!l) { if (sawAnyContent) textLines.push(''); continue; }
        // Match bare timestamp OR one with "(edited)" prefix/suffix
        if (TIMESTAMP_RE.test(l) || TIMESTAMP_RE.test(l.replace(/\(?\s*edited\s*\)?/gi, '').replace(/\s*[·•]\s*/g, ' ').trim())) { inContent = true; continue; }
        if (!inContent) continue;
        if (/^Follow(ing)?$/i.test(l)) continue;
        if (/^[•·]\s*You$/i.test(l)) continue;
        if (/^You$/i.test(l)) continue;
        if (sawAnyContent && /^\d{1,4}$/.test(l)) continue; // stray reaction count
        textLines.push(l);
        sawAnyContent = true;
      }
      const commentText = textLines.join('\n').trim();
      if (!commentText) continue;

      const idSeed = `${author}|${commentText.slice(0, 80)}`;
      let hash = 0;
      for (let k = 0; k < idSeed.length; k++) {
        hash = ((hash << 5) - hash + idSeed.charCodeAt(k)) | 0;
      }
      const id = `txt_${Math.abs(hash).toString(36)}`;

      // We can't easily distinguish nested replies from top-level via text
      // alone. extractOurThread() handles both: nested isReply=true AND
      // top-level comments mentioning our first name. isReply=false is the
      // safe default — top-level branch picks up replies.
      comments.push({ id, author, text: commentText, isReply: false });
    }
    return comments;
  }, myDisplayName);

  // One-time diagnostic: if we got nothing at all, log the body length so
  // we can tell whether the page didn't render vs. our parser missed all
  // markers. Cheap and only fires on empty results.
  if (rawComments.length === 0) {
    const len = await page.evaluate(() => (document.body?.innerText ?? '').length).catch(() => 0);
    console.warn(`[parse] no comments parsed for ${postUrl} (body innerText: ${len} chars)`);
  }

  return rawComments.map(c => ({
    id: c.id,
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
let monitorRunning = false;

export async function runOutboundReplyMonitor(): Promise<OutboundMonitorStats> {
  if (monitorRunning) {
    console.log('[outbound-monitor] Already running — skipping.');
    return { postsChecked: 0, newReplies: 0 };
  }
  monitorRunning = true;
  try {
    return await _runMonitor();
  } finally {
    monitorRunning = false;
  }
}

async function _runMonitor(): Promise<OutboundMonitorStats> {
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
  const release = await acquireBrowserLock();
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

    const newThreadReplies = thread.filter(c => {
      if (c.author.toLowerCase().includes(myName)) return false;
      if (isCommentSeen(c.id)) return false;
      // Content-based dedup: also check a hash of author+text in case the comment ID changed between scrapes
      const contentHash = crypto.createHash('md5').update(`${comments[0].postUrl}:${c.author}:${c.text.slice(0, 50)}`).digest('hex');
      if (isCommentSeen(contentHash)) return false;
      return true;
    });

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
      // Also mark content hash so we don't re-detect if the comment ID changes between scrapes
      const contentHash = crypto.createHash('md5').update(`${comments[0].postUrl}:${reply.author}:${reply.text.slice(0, 50)}`).digest('hex');
      markCommentSeen(contentHash);

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
