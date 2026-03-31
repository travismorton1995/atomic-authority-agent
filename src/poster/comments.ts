import { chromium } from 'playwright';
import path from 'path';
import crypto from 'crypto';

const USER_DATA_DIR = path.resolve('user_data');

export interface ScrapedComment {
  id: string;       // LinkedIn comment URN (data-id) or MD5 hash fallback
  author: string;
  text: string;
  isReply: boolean;
}

export async function scrapeComments(postUrl: string): Promise<ScrapedComment[]> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Expand the comments section (click the comment count button)
    const expandBtn = page.locator('button[aria-label*="comment on"]').first();
    if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expandBtn.click();
      await page.waitForTimeout(2000);
    }

    // Load more top-level comments if paginated
    for (let i = 0; i < 10; i++) {
      const btn = page.locator('button[aria-label*="Load more comments"]').first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
      } else {
        break;
      }
    }

    // Expand reply threads
    const replyExpandBtns = page.locator('button[aria-label*="replies"]');
    const expandCount = await replyExpandBtns.count();
    for (let i = 0; i < expandCount; i++) {
      await replyExpandBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(500);
    }

    const rawComments = await page.evaluate(() => {
      // LinkedIn comment articles carry a data-id with the comment URN
      const items = document.querySelectorAll<HTMLElement>('article[data-id^="urn:li:comment:"]');
      return Array.from(items).map(item => {
        const dataId = item.getAttribute('data-id') ?? '';
        // Top-level: urn:li:comment:(activity:xxx,yyy)
        // Reply:     urn:li:comment:(comment:xxx,yyy)
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
      id: c.dataId || crypto.createHash('md5').update(`${postUrl}:${c.author}:${c.text.slice(0, 50)}`).digest('hex'),
      author: c.author,
      text: c.text,
      isReply: c.isReply,
    }));
  } finally {
    await context.close();
  }
}

export async function postCommentReply(
  postUrl: string,
  commentId: string,
  replyText: string
): Promise<void> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Expand comments section first
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

    // Expand reply threads
    const replyExpandBtns = page.locator('button[aria-label*="replies"]');
    const expandCount = await replyExpandBtns.count();
    for (let i = 0; i < expandCount; i++) {
      await replyExpandBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // Locate the comment article by its LinkedIn URN data-id
    const commentEl = page.locator(`article[data-id="${commentId}"]`).first();
    if (!await commentEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      throw new Error(`Comment not found on page (id: ${commentId})`);
    }

    await commentEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Click the Reply button inside this comment
    const replyBtn = commentEl.locator('button[aria-label*="Reply to"]').first();
    await replyBtn.waitFor({ state: 'visible', timeout: 5000 });
    await replyBtn.click();
    await page.waitForTimeout(2000);

    // Type into the reply composer — use keyboard.type() to preserve the @mention
    // that LinkedIn pre-fills when the reply box opens (fill() would wipe it)
    const composer = page.locator(
      '.comments-comment-texteditor .ql-editor, .comments-comment-box__form .ql-editor'
    ).last();
    await composer.waitFor({ state: 'visible', timeout: 5000 });
    await composer.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(replyText, { delay: 40 });
    await page.waitForTimeout(500);

    // Submit
    const submitBtn = page.locator(
      'button[aria-label*="Post comment"], button.comments-comment-box__submit-button--cr, button.comments-comment-box__submit-button'
    ).last();
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
    await page.waitForTimeout(2000);
  } finally {
    await context.close();
  }
}
