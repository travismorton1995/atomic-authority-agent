import { chromium } from 'playwright';
import path from 'path';

const USER_DATA_DIR = path.resolve('user_data');

export interface ScrapedPost {
  text: string;
  authorName: string;
  profileUrl: string; // author's LinkedIn profile URL (for cooldown tracking)
  url: string;
}

// Scrapes a single LinkedIn post URL and returns the post text and author name.
export async function scrapePostByUrl(postUrl: string): Promise<ScrapedPost> {
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
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Click "see more" if present to expand truncated post
    try {
      const seeMore = page.locator('button:has-text("see more"), button:has-text("…more")').first();
      if (await seeMore.isVisible({ timeout: 2000 })) {
        await seeMore.click();
        await page.waitForTimeout(1000);
      }
    } catch {
      // No "see more" button — post is already fully visible
    }

    const result = await page.evaluate(() => {
      // Post text — try multiple selectors
      const textEl = document.querySelector(
        '.update-components-text, ' +
        '.feed-shared-update-v2__description .feed-shared-inline-show-more-text, ' +
        '.feed-shared-text'
      );
      let text = textEl?.textContent?.trim() ?? '';

      // Fallback: find the longest span[dir="ltr"] which is typically the post body
      if (!text || text.length < 20) {
        const candidates = document.querySelectorAll('span[dir="ltr"]');
        candidates.forEach(el => {
          const t = el.textContent?.trim() ?? '';
          if (t.length > text.length) text = t;
        });
      }

      // Author name
      const authorEl = document.querySelector(
        '.update-components-actor__title span[aria-hidden="true"], ' +
        '.update-components-actor__name span[aria-hidden="true"], ' +
        '.update-components-actor__name, ' +
        '.feed-shared-actor__name'
      );
      const authorName = authorEl?.textContent?.trim() ?? '';

      // Author profile URL — from the first /in/ or /company/ link near the author name
      const authorLink = document.querySelector(
        '.update-components-actor__container a[href*="/in/"], ' +
        '.update-components-actor__container a[href*="/company/"], ' +
        'a[href*="/in/"][data-tracking-control-name*="actor"], ' +
        'a[href*="/company/"][data-tracking-control-name*="actor"]'
      );
      const profileUrl = authorLink?.getAttribute('href')?.split('?')[0] ?? '';

      return { text, authorName, profileUrl };
    });

    if (!result.text || result.text.length < 20) {
      throw new Error('Could not extract post text from page.');
    }

    return {
      text: result.text,
      authorName: result.authorName || 'Unknown',
      profileUrl: result.profileUrl
        ? (result.profileUrl.startsWith('http')
          ? result.profileUrl.replace(/\/$/, '') + '/'
          : `https://www.linkedin.com${result.profileUrl.replace(/\/$/, '')}/`)
        : '',
      url: postUrl,
    };
  } finally {
    await context.close();
  }
}
