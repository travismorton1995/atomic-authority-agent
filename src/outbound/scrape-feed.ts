import { chromium } from 'playwright';
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
  // Match patterns like "2h", "1d", "3w", "1mo"
  const m = t.match(/(\d+)\s*(s|m|h|d|w|mo)/);
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

export async function scrapeProfilePosts(profileUrl: string): Promise<ScrapedPost[]> {
  // Personal profiles: /in/username/recent-activity/shares/
  // Company pages:     /company/org/posts/
  const isCompany = profileUrl.includes('/company/');
  const activityUrl = profileUrl.replace(/\/$/, '') + (isCompany ? '/posts/' : '/recent-activity/shares/');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

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
      .filter(p => p.url && (p.ageHours === null || p.ageHours <= 48));
  } finally {
    await context.close();
  }
}
