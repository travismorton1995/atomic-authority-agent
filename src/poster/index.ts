import { chromium } from 'playwright';
import path from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync } from 'fs';

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
  firstComment?: string; // posted as first comment immediately after publishing
  imageUrl?: string;     // og:image URL — downloaded and attached to the post
}

async function downloadImageToTemp(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AtomicAuthorityBot/1.0)' },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('gif') ? '.gif'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';

    const tempPath = path.join(tmpdir(), `atomic-authority-image${ext}`);
    writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()));
    return tempPath;
  } catch {
    return null;
  }
}

// Silently checks whether the saved LinkedIn session is still valid.
// Returns true if the session is active, false if login is required.
export async function pingSession(): Promise<boolean> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(LINKEDIN_FEED, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const url = page.url();
    const expired =
      url.includes('/login') ||
      url.includes('/authwall') ||
      url.includes('/checkpoint') ||
      await page.locator('input[name="session_key"]').isVisible({ timeout: 2000 }).catch(() => false);
    return !expired;
  } catch {
    return false;
  } finally {
    await context.close();
  }
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

    // Wait for the composer text area — more reliable than waiting for the dialog wrapper,
    // which has a hidden loader variant that confuses .first()
    const textArea = page.locator('.share-box-v2__modal div[contenteditable="true"], div[role="textbox"], .ql-editor').first();
    await textArea.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(500);
    await textArea.click();

    // Type content — use keyboard to handle newlines correctly
    for (const line of content.split('\n')) {
      await page.keyboard.type(line, { delay: 10 });
      await page.keyboard.press('Enter');
    }

    // Attach image if provided
    if (options.imageUrl) {
      const tempPath = await downloadImageToTemp(options.imageUrl);
      if (tempPath) {
        try {
          console.log('Uploading image...');

          // Click the media button (identified by its SVG data-test-icon attribute)
          const mediaBtn = page.locator('button:has([data-test-icon="image-medium"])').first();
          await mediaBtn.waitFor({ state: 'visible', timeout: 10000 });
          await mediaBtn.click();

          // LinkedIn opens a native OS file picker — bypass it entirely by setting
          // files directly on the hidden file input that backs the button
          await page.waitForTimeout(1000);
          const fileInput = page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(tempPath);

          // Wait for LinkedIn to process the upload and show the image preview
          await page.waitForTimeout(5000);

          // Click "Next" to proceed past LinkedIn's image crop/edit step
          const nextBtn = page.locator('button').filter({ hasText: 'Next' }).first();
          await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
          await nextBtn.click();

          await page.waitForTimeout(2000);
          console.log('Image uploaded.');
        } catch (err) {
          console.warn('Image upload failed (non-fatal) — posting text only:', (err as any)?.message);
        } finally {
          unlinkSync(tempPath);
        }
      } else {
        console.warn('Failed to download image — posting text only.');
      }
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

    // Wait for the composer to disappear — text area going hidden confirms the post was submitted
    await textArea.waitFor({ state: 'hidden', timeout: 20000 });

    console.log('Successfully posted to LinkedIn.');

    // Post first comment if provided
    if (options.firstComment) {
      await postFirstComment(page, options.firstComment);
    }
  } finally {
    await context.close();
  }
}

async function postFirstComment(page: import('playwright').Page, comment: string): Promise<void> {
  const profileUrl = process.env.LINKEDIN_PROFILE_URL;
  if (!profileUrl) {
    console.warn('LINKEDIN_PROFILE_URL not set — skipping first comment.');
    return;
  }

  try {
    // Navigate to the profile's recent activity page — most recent post is always first
    const activityUrl = profileUrl.replace(/\/$/, '') + '/recent-activity/all/';
    console.log('Navigating to activity page for first comment...');
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Find the first post on the activity page
    const firstPost = page.locator('div[data-urn], div[data-id], article').first();
    await firstPost.waitFor({ state: 'visible', timeout: 15000 });

    // Scroll into view and hover to reveal the reaction bar / comment area
    await firstPost.scrollIntoViewIfNeeded();
    await firstPost.hover();
    await page.waitForTimeout(1500);

    // LinkedIn reaction buttons use <span class="artdeco-button__text">Comment</span>
    // Use :has() to target the button containing that span, filtered by text content
    const commentBtn = firstPost
      .locator('button:has(span.artdeco-button__text)')
      .filter({ hasText: 'Comment' })
      .first();

    await commentBtn.waitFor({ state: 'visible', timeout: 10000 });
    await commentBtn.click();

    // Input is auto-focused after click — type directly without locating the element
    await page.waitForTimeout(1500);

    const lines = comment.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await page.keyboard.type(lines[i], { delay: 10 });
      if (i < lines.length - 1) {
        await page.keyboard.press('Shift+Enter'); // newline within comment
      }
    }

    await page.waitForTimeout(1000);

    // The submit "Comment" button is inside the comment composer box, NOT the reaction bar.
    // Scope the search to comment-box containers to avoid clicking reaction bar buttons on other posts.
    const clicked = await page.evaluate(() => {
      const composerContainerSelectors = [
        'div.comments-comment-box',
        'div.comments-reply-box',
        'div[class*="comment-box"]',
        'div[class*="comment-form"]',
      ];

      for (const sel of composerContainerSelectors) {
        const composer = document.querySelector(sel);
        if (!composer) continue;
        const spans = Array.from(composer.querySelectorAll('span.artdeco-button__text'));
        const submitSpan = spans.find(s => s.textContent?.trim() === 'Comment');
        if (submitSpan) {
          (submitSpan.closest('button') as HTMLButtonElement)?.click();
          return sel; // return which selector worked
        }
      }
      return null;
    });

    if (!clicked) {
      throw new Error('Could not find Comment submit button inside composer container');
    }

    console.log(`Comment submitted (found via: ${clicked}).`);
    await page.waitForTimeout(20000); // wait to observe result before browser closes
    console.log('First comment posted.');
  } catch (err) {
    // Non-fatal — post already succeeded
    console.warn('Failed to post first comment (non-fatal):', err);
  }
}
