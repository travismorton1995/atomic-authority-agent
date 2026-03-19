import { chromium } from 'playwright';
import path from 'path';

const USER_DATA_DIR = path.resolve('user_data');
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

export class LinkedInSessionExpiredError extends Error {
  constructor() {
    super(
      'LinkedIn session has expired or is not established.\n' +
      'Run the scheduler with LINKEDIN_HEADLESS=false to log in manually:\n' +
      '  LINKEDIN_HEADLESS=false npm run scheduler'
    );
    this.name = 'LinkedInSessionExpiredError';
  }
}

export async function postToLinkedIn(content: string): Promise<void> {
  const headless = process.env.LINKEDIN_HEADLESS === 'true';

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    locale: 'en-US',
    timezoneId: 'America/Toronto',
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    // Navigate to LinkedIn feed
    await page.goto(LINKEDIN_FEED, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Detect session expiry — login wall or authwall
    const currentUrl = page.url();
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/authwall') ||
      currentUrl.includes('/checkpoint') ||
      await page.locator('input[name="session_key"]').isVisible({ timeout: 3000 }).catch(() => false)
    ) {
      throw new LinkedInSessionExpiredError();
    }

    // Click "Start a post"
    const startPostBtn = page.locator('[aria-label="Start a post"]').first();
    await startPostBtn.waitFor({ state: 'visible', timeout: 15000 });
    await startPostBtn.click();

    // Wait for the composer modal
    const modal = page.locator('[role="dialog"]');
    await modal.waitFor({ state: 'visible', timeout: 10000 });

    // Click into the contenteditable text area and type content
    const textArea = modal.locator('div[role="textbox"]').first();
    await textArea.waitFor({ state: 'visible', timeout: 10000 });
    await textArea.click();

    // Type content — use keyboard to handle newlines correctly
    for (const line of content.split('\n')) {
      await page.keyboard.type(line, { delay: 10 });
      await page.keyboard.press('Enter');
    }

    // Brief pause to let LinkedIn process the input
    await page.waitForTimeout(1000);

    // Click the Post button inside the modal
    const postBtn = modal.locator('button[aria-label="Post"]');
    await postBtn.waitFor({ state: 'visible', timeout: 10000 });

    // Confirm it's enabled (LinkedIn disables it for empty posts)
    const isDisabled = await postBtn.isDisabled();
    if (isDisabled) {
      throw new Error('Post button is disabled — content may not have been entered correctly.');
    }

    await postBtn.click();

    // Wait for the modal to close — confirmation of successful post
    await modal.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('Successfully posted to LinkedIn.');
  } finally {
    await context.close();
  }
}
