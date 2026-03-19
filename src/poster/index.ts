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

export interface PostOptions {
  forceHeaded?: boolean; // override LINKEDIN_HEADLESS — always show browser
}

export async function postToLinkedIn(content: string, options: PostOptions = {}): Promise<void> {
  const headless = options.forceHeaded ? false : process.env.LINKEDIN_HEADLESS === 'true';

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    locale: 'en-US',
    timezoneId: 'America/Toronto',
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    // Navigate to LinkedIn feed
    await page.goto(LINKEDIN_FEED, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Detect session expiry — login wall or authwall
    const currentUrl = page.url();
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/authwall') ||
      currentUrl.includes('/checkpoint') ||
      await page.locator('input[name="session_key"]').isVisible({ timeout: 3000 }).catch(() => false)
    ) {
      if (!headless) {
        console.log('LinkedIn login required. Please log in in the browser window.');
        console.log('Waiting up to 3 minutes for you to complete login...');
        await page.waitForURL('**/feed/**', { timeout: 180000 });
      } else {
        throw new LinkedInSessionExpiredError();
      }
    }

    // Wait for feed to fully settle before interacting
    await page.waitForTimeout(2000);

    // Click "Start a post"
    const startPostBtn = page.locator('[aria-label="Start a post"]').first();
    await startPostBtn.waitFor({ state: 'visible', timeout: 20000 });
    await startPostBtn.click();

    // Wait for the composer modal
    const modal = page.locator('[role="dialog"]').first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Click into the contenteditable text area
    const textArea = page.locator('div[contenteditable="true"], div[role="textbox"], .ql-editor').first();
    await textArea.waitFor({ state: 'visible', timeout: 15000 });
    await textArea.click();

    // Type content — use keyboard to handle newlines correctly
    for (const line of content.split('\n')) {
      await page.keyboard.type(line, { delay: 10 });
      await page.keyboard.press('Enter');
    }

    // Pause to let LinkedIn process the input and enable the Post button
    await page.waitForTimeout(1500);

    // Click the Post button — try aria-label first, fall back to text content
    const postBtn = page.locator('button[aria-label="Post"], button:has-text("Post")').last();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });

    const isDisabled = await postBtn.isDisabled();
    if (isDisabled) {
      throw new Error('Post button is disabled — content may not have been entered correctly.');
    }

    await postBtn.click();

    // Wait for the modal to close — confirmation of successful post
    await modal.waitFor({ state: 'hidden', timeout: 20000 });

    console.log('Successfully posted to LinkedIn.');
  } finally {
    await context.close();
  }
}
