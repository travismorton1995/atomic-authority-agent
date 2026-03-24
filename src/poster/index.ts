import { chromium, type Page } from 'playwright';
import path from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import { MENTIONS } from './mentions.js';

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
    channel: 'chrome',
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
    channel: 'chrome',
    headless,
    locale: 'en-US',
    timezoneId: 'America/Toronto',
    viewport: { width: 1280, height: 800 },
    slowMo: 0,
  });

  // Suppress Playwright's webdriver fingerprint before any page load.
  // LinkedIn's JS checks navigator.webdriver and is more aggressive about
  // blocking automated sessions on the image upload API endpoint (/dms/image).
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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

    // Type content — handle [[MENTION:X]] markers with LinkedIn autocomplete
    await typeContentWithMentions(page, content);

    // Attach image if provided
    //
    // KNOWN ISSUE (parked 2026-03-20): Image posts consistently fail on LinkedIn
    // with "Network connection failed. Try refreshing the page." after the Post
    // button is clicked. Text-only posts work fine on the same session.
    //
    // Root cause (suspected): Playwright sets navigator.webdriver = true even when
    // using channel: 'chrome'. LinkedIn's JS detects this flag and is more aggressive
    // about blocking automated sessions on image upload API endpoints (/dms/image).
    // Regular text posts hit a simpler endpoint that is not as strictly gated.
    //
    // What was tried:
    //   - Switched from Playwright's bundled Chromium to system Chrome (channel: 'chrome')
    //     → same error, LinkedIn still detects webdriver flag
    //   - Used page.waitForEvent('filechooser') instead of setInputFiles on hidden input
    //     → this WORKS and prevents Windows Explorer from opening (keep this)
    //   - Increased waits, slowMo, error detection → did not resolve the core issue
    //
    // To pick this up later:
    //   - Try suppressing navigator.webdriver via context.addInitScript():
    if (options.imageUrl) {
      const tempPath = await downloadImageToTemp(options.imageUrl);
      if (tempPath) {
        try {
          console.log('Uploading image...');

          // Click the media button (identified by its SVG data-test-icon attribute).
          // Set up the filechooser listener BEFORE clicking so Playwright intercepts
          // the event at the browser level — this prevents Windows Explorer from opening.
          const mediaBtn = page.locator('button:has([data-test-icon="image-medium"])').first();
          await mediaBtn.waitFor({ state: 'visible', timeout: 10000 });

          console.log('Intercepting file chooser and setting image...');
          let uploadSucceeded = false;

          try {
            const [fileChooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 10000 }),
              mediaBtn.click(),
            ]);
            await fileChooser.setFiles(tempPath);
            uploadSucceeded = true;
          } catch {
            // Filechooser intercept failed — fall back to setInputFiles on hidden input
            console.log('Filechooser intercept failed — trying setInputFiles fallback...');
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(tempPath);
            uploadSucceeded = true;
          }

          if (uploadSucceeded) {
            console.log('File set — waiting for LinkedIn to process upload...');

            // Wait for LinkedIn to process the upload and show the image preview
            await page.waitForTimeout(5000);

            // Click "Next" to proceed past LinkedIn's image crop/edit step
            console.log('Looking for Next button...');
            const nextBtn = page.locator('button').filter({ hasText: 'Next' }).first();
            await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
            console.log('Clicking Next...');
            await nextBtn.click();

            // Wait for the composer to settle into the image post view
            await page.waitForTimeout(3000);
            console.log('Image upload flow complete — back in composer.');
          }
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
    // Use .last() as LinkedIn renders multiple candidate buttons; the active one is last
    const postBtn = page.locator('button[aria-label="Post"], button:has-text("Post")').last();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });

    const isDisabled = await postBtn.isDisabled();
    if (isDisabled) {
      throw new Error('Post button is disabled — content may not have been entered correctly.');
    }

    console.log('Clicking Post button...');
    await postBtn.click();
    console.log('Post button clicked — watching for success or error...');

    // LinkedIn shows "Network connection failed" INSIDE the composer (next to the Post
    // button) while the modal is still open. We must detect it before the modal closes,
    // otherwise it disappears and we incorrectly report success.
    //
    // Strategy: poll every 500ms for up to 30s, checking for either:
    //   - Post button gone → success
    //   - Known error text visible → throw immediately
    const knownErrors = [
      'Network connection failed',
      'Something went wrong',
      'Try refreshing the page',
    ];
    const deadline = Date.now() + 90000;
    let posted = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(500);

      // Check for error messages — they appear INSIDE the composer while it is still open.
      // LinkedIn renders errors as visible text AND in aria-label/title attributes.
      for (const msg of knownErrors) {
        const byText = await page.getByText(msg, { exact: false }).first().isVisible().catch(() => false);
        const byAriaLabel = await page.locator(`[aria-label*="${msg}"]`).first().isVisible().catch(() => false);
        const byTitle = await page.locator(`[title*="${msg}"]`).first().isVisible().catch(() => false);
        if (byText || byAriaLabel || byTitle) {
          throw new Error(`LinkedIn error during post: "${msg}"`);
        }
      }
      // CSS class-based fallback (LinkedIn inline feedback component)
      const inlineFeedback = await page.locator('.artdeco-inline-feedback--error').first().isVisible().catch(() => false);
      if (inlineFeedback) {
        const errorText = await page.locator('.artdeco-inline-feedback--error').first().textContent().catch(() => 'unknown');
        throw new Error(`LinkedIn error during post: "${errorText?.trim()}"`);
      }

      // Check if composer closed (success)
      const buttonGone = await postBtn.isHidden().catch(() => false);
      if (buttonGone) { posted = true; break; }
    }

    if (!posted) {
      // Capture a screenshot to diagnose what LinkedIn is showing
      const screenshotPath = 'post-failure-debug.png';
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      console.error(`Screenshot saved to ${screenshotPath} — check it to see what LinkedIn is showing.`);
      throw new Error('Timed out waiting for post to complete — composer still open after 30s.');
    }

    console.log('Successfully posted to LinkedIn.');

    // Post first comment if provided — wait for LinkedIn to process and surface
    // the new post in the activity feed before navigating there
    if (options.firstComment) {
      console.log('Waiting for post to appear in activity feed...');
      await page.waitForTimeout(8000);
      await postFirstComment(page, options.firstComment);
    }
  } finally {
    await context.close();
  }
}

// Splits post content on [[MENTION:Name]] markers and types each segment,
// performing the LinkedIn @mention autocomplete interaction for each marker.
// Falls back to plain text if the dropdown doesn't appear.
async function typeContentWithMentions(page: Page, content: string): Promise<void> {
  const MENTION_RE = /\[\[MENTION:([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MENTION_RE.exec(content)) !== null) {
    // Type any plain text before this marker
    const before = content.slice(lastIndex, match.index);
    if (before) {
      const lines = before.split('\n');
      for (let i = 0; i < lines.length; i++) {
        await page.keyboard.type(lines[i], { delay: 10 });
        if (i < lines.length - 1) await page.keyboard.press('Enter');
      }
    }

    const name = match[1];
    const entry = MENTIONS[name];

    if (entry?.verified) {
      const inserted = await insertMention(page, entry.searchTerm, name);
      if (!inserted) {
        // Fallback: type plain name
        await page.keyboard.type(name, { delay: 10 });
      }
    } else {
      // Not verified — type plain name
      await page.keyboard.type(name, { delay: 10 });
    }

    lastIndex = match.index + match[0].length;
  }

  // Type any remaining text after the last marker
  const tail = content.slice(lastIndex);
  if (tail) {
    for (const line of tail.split('\n')) {
      await page.keyboard.type(line, { delay: 10 });
      await page.keyboard.press('Enter');
    }
  }
}

// Types `@searchTerm` then uses Playwright's native locators (accessibility tree)
// to find and click the first typeahead suggestion. Falls back to plain text
// if no suggestion appears within 5 seconds.
async function insertMention(page: Page, searchTerm: string, displayName: string): Promise<boolean> {
  const typed = `@${searchTerm}`;

  try {
    // Type @ to trigger mention mode, pause, then type the search term
    await page.keyboard.type('@', { delay: 50 });
    await page.waitForTimeout(500);
    for (const char of searchTerm) {
      await page.keyboard.type(char, { delay: 60 });
    }

    // LinkedIn's typeahead exposes results as ARIA role="option" elements.
    const option = page.getByRole('option').first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.waitForTimeout(400);
    console.log(`Inserted @mention: ${displayName}`);
    return true;
  } catch (err) {
    console.warn(`@mention failed for "${displayName}" — plain text fallback. (${(err as Error).message})`);
    for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
    return false;
  }
}

async function postFirstComment(page: Page, comment: string): Promise<void> {
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
