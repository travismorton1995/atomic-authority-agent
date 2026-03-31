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
    headless: true,
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Expand top-level "load more comments" buttons
    for (let i = 0; i < 10; i++) {
      const btn = page.locator('button[aria-label*="Load more comments"], button[aria-label*="more comment"]').first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
      } else {
        break;
      }
    }

    // Expand all reply threads
    const replyExpandBtns = page.locator('button[aria-label*="Load previous replies"], button[aria-label*="more repl"]');
    const expandCount = await replyExpandBtns.count();
    for (let i = 0; i < expandCount; i++) {
      await replyExpandBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(500);
    }

    const rawComments = await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLElement>('.comments-comment-item');
      return Array.from(items).map(item => {
        const dataId = item.getAttribute('data-id') ?? '';
        const isReply = !!item.closest('.comments-comment-item__nested-items');
        const author = (
          item.querySelector('.comments-post-meta__name-text')?.textContent ??
          item.querySelector('[data-test-app-aware-link]')?.textContent ??
          'Unknown'
        ).trim();
        const text = (
          item.querySelector('.comments-comment-item__main-content')?.textContent ??
          item.querySelector('.update-components-text')?.textContent ??
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
    headless: true,
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Expand comments so the target comment is in the DOM
    for (let i = 0; i < 10; i++) {
      const btn = page.locator('button[aria-label*="Load more comments"]').first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
      } else {
        break;
      }
    }

    const replyExpandBtns = page.locator('button[aria-label*="Load previous replies"]');
    const expandCount = await replyExpandBtns.count();
    for (let i = 0; i < expandCount; i++) {
      await replyExpandBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // Locate the comment element by its data-id (LinkedIn URN)
    const commentEl = page.locator(`[data-id="${commentId}"]`).first();
    if (!await commentEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      throw new Error(`Comment not found on page (id: ${commentId})`);
    }

    await commentEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Click the Reply button inside this comment
    const replyBtn = commentEl.locator('button[aria-label*="Reply"]').first();
    await replyBtn.waitFor({ state: 'visible', timeout: 5000 });
    await replyBtn.click();
    await page.waitForTimeout(2000);

    // Type into the reply composer (last active .ql-editor on page)
    const composer = page.locator(
      '.comments-comment-texteditor .ql-editor, .comments-comment-box__form .ql-editor'
    ).last();
    await composer.waitFor({ state: 'visible', timeout: 5000 });
    await composer.click();
    await composer.fill(replyText);
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
