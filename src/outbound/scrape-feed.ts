import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';

const USER_DATA_DIR = path.resolve('user_data');

export interface ScrapedPost {
  id: string;           // activity URN or MD5 fallback
  url: string;          // https://www.linkedin.com/feed/update/urn:li:activity:XXXX/
  text: string;
  authorName: string;
  ageHours: number | null;
}

function parseAgeHours(timeText: string): number | null {
  const t = timeText.trim().toLowerCase();
  const m = t.match(/(\d+)\s*(mo|s|m|h|d|w)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':  return n / 3600;
    case 'm':  return n / 60;
    case 'h':  return n;
    case 'd':  return n * 24;
    case 'w':  return n * 24 * 7;
    case 'mo': return n * 24 * 30;
    default:   return null;
  }
}

// Extracts posts from the currently loaded page — reused by both profile and hashtag scrapers.
async function scrapeVisiblePosts(page: Page): Promise<ScrapedPost[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{
      urn: string;
      text: string;
      authorName: string;
      timeText: string;
    }> = [];

    const containers = document.querySelectorAll<HTMLElement>(
      '[data-urn*="urn:li:activity:"]'
    );

    containers.forEach(el => {
      const urn = el.getAttribute('data-urn') ?? '';
      if (!urn.includes('urn:li:activity:')) return;

      const textEl = el.querySelector(
        '.update-components-text, ' +
        '.feed-shared-update-v2__description .feed-shared-inline-show-more-text, ' +
        '.feed-shared-text'
      );
      const text = textEl?.textContent?.trim() ?? '';
      if (!text) return;

      const authorEl = el.querySelector(
        '.update-components-actor__title span[aria-hidden="true"], ' +
        '.update-components-actor__name span[aria-hidden="true"], ' +
        '.update-components-actor__name, ' +
        '.feed-shared-actor__name'
      );
      const authorName = authorEl?.textContent?.trim() ?? '';

      const timeEl = el.querySelector(
        '.update-components-actor__sub-description span[aria-hidden="true"], ' +
        '.feed-shared-actor__sub-description, ' +
        'time'
      );
      const timeText = timeEl?.textContent?.trim() ?? '';

      results.push({ urn, text, authorName, timeText });
    });

    return results;
  });

  return raw
    .map(p => {
      const activityId = p.urn.match(/urn:li:activity:(\d+)/)?.[1];
      const url = activityId
        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
        : '';
      return {
        id: p.urn || crypto.createHash('md5').update(p.text.slice(0, 100)).digest('hex'),
        url,
        text: p.text,
        authorName: p.authorName,
        ageHours: parseAgeHours(p.timeText),
      };
    })
    .filter(p => p.url && (p.ageHours === null || p.ageHours <= 12));
}

async function scrapePagePosts(page: Page, activityUrl: string): Promise<ScrapedPost[]> {
  await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-urn*="urn:li:activity:"]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  return scrapeVisiblePosts(page);
}

// Opens its own browser context — use for one-off scrapes or testing.
export async function scrapeProfilePosts(profileUrl: string): Promise<ScrapedPost[]> {
  const isCompany = profileUrl.includes('/company/');
  const activityUrl = profileUrl.replace(/\/$/, '') + (isCompany ? '/posts/' : '/recent-activity/shares/');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    return await scrapePagePosts(page, activityUrl);
  } finally {
    await context.close();
  }
}

// Opens a shared browser context for scraping multiple profiles in one session.
export async function openScrapeContext(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
}

// Scrapes a single profile using an already-open page — no context launch/teardown overhead.
export async function scrapeProfilePostsWithPage(profileUrl: string, page: Page): Promise<ScrapedPost[]> {
  const isCompany = profileUrl.includes('/company/');
  const activityUrl = profileUrl.replace(/\/$/, '') + (isCompany ? '/posts/' : '/recent-activity/shares/');
  return scrapePagePosts(page, activityUrl);
}

// Scrapes a LinkedIn hashtag feed for recent posts, filtered to past 24 hours.
export async function scrapeHashtagWithPage(hashtag: string, page: Page): Promise<ScrapedPost[]> {
  const tag = hashtag.replace(/^#/, '').toLowerCase();
  const url = `https://www.linkedin.com/feed/hashtag/${tag}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Click "Past 24 hours" filter to surface recent posts
  // LinkedIn renders these as <button> elements with varying markup — try multiple selectors
  try {
    const btn = page.locator('label:has-text("Past 24 hours")').first();
    await btn.waitFor({ timeout: 5000 });
    // Click and wait for navigation/reload — LinkedIn may do a full page refresh or AJAX update
    await btn.click();
    await page.waitForTimeout(3000);
  } catch {
    // Filter button not found — fall back to default feed
    await page.waitForSelector('[data-urn*="urn:li:activity:"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }


  return scrapeSearchResults(page);
}

// Scrapes posts from LinkedIn search results pages.
// Search results use obfuscated classes and no data-urn attributes.
// Posts are identified by <a href="/feed/update/urn:li:..."> links inside [role="listitem"] containers.
async function scrapeSearchResults(page: Page): Promise<ScrapedPost[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{
      urn: string;
      postUrl: string;
      text: string;
      authorName: string;
      timeText: string;
    }> = [];

    const seen = new Set<string>();

    // Find all links to posts — these contain the URN
    const postLinks = document.querySelectorAll<HTMLAnchorElement>('a[href*="/feed/update/"]');

    postLinks.forEach(link => {
      const href = link.getAttribute('href') ?? '';
      // Extract URN — can be urn:li:activity:XXX or urn:li:ugcPost:XXX
      const urnMatch = href.match(/urn:li:(activity|ugcPost):(\d+)/);
      if (!urnMatch) return;
      const urn = `urn:li:${urnMatch[1]}:${urnMatch[2]}`;
      if (seen.has(urn)) return;
      seen.add(urn);

      // Walk up to find the post container — [role="listitem"] or go up ~8 levels
      let container: HTMLElement | null = link;
      for (let i = 0; i < 10 && container; i++) {
        if (container.getAttribute('role') === 'listitem') break;
        container = container.parentElement;
      }
      if (!container) return;

      // Post text — look for span[dir="ltr"] with substantial text, or the longest text block
      const textCandidates = container.querySelectorAll('span[dir="ltr"]');
      let text = '';
      textCandidates.forEach(el => {
        const t = el.textContent?.trim() ?? '';
        if (t.length > text.length) text = t;
      });
      if (!text || text.length < 20) return;

      // Author name — first <a> linking to /in/ or /company/ within the container
      let authorName = '';
      const authorLink = container.querySelector('a[href*="/in/"], a[href*="/company/"]');
      if (authorLink) {
        // Prefer span[aria-hidden="true"] inside the link, else link text
        const nameSpan = authorLink.querySelector('span[aria-hidden="true"]');
        authorName = nameSpan?.textContent?.trim() ?? authorLink.textContent?.trim() ?? '';
      }

      // Time — look for text matching patterns like "12m", "4h", "1d" near the author
      let timeText = '';
      const allText = container.innerText ?? '';
      const timeMatch = allText.match(/\b(\d+)(s|m|h|d|w|mo)\b/);
      if (timeMatch) timeText = timeMatch[0];

      const cleanUrl = `https://www.linkedin.com/feed/update/${urn}/`;
      results.push({ urn, postUrl: cleanUrl, text, authorName, timeText });
    });

    return results;
  });

  return raw.map(p => ({
    id: p.urn,
    url: p.postUrl,
    text: p.text,
    authorName: p.authorName,
    ageHours: parseAgeHours(p.timeText),
  })).filter(p => p.ageHours === null || p.ageHours <= 12);
}
