import { chromium, type Page } from 'playwright';
import path from 'path';
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

    // Type content — handle [[MENTION:X]] markers with LinkedIn autocomplete
    await typeContentWithMentions(page, content);

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
      for (const line of before.split('\n')) {
        await page.keyboard.type(line, { delay: 10 });
        if (before.indexOf('\n') !== -1) await page.keyboard.press('Enter');
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

// Types `@searchTerm` into the composer and clicks the first autocomplete result.
// Returns true if the mention was successfully inserted, false if the dropdown
// didn't appear (caller should fall back to plain text).
async function insertMention(page: Page, searchTerm: string, displayName: string): Promise<boolean> {
  try {
    await page.keyboard.type(`@${searchTerm}`, { delay: 30 });

    // Wait for the typeahead dropdown to appear
    const dropdown = page.locator(
      'div.mention-typeahead, ul[role="listbox"], div[data-test-id="mention-typeahead"]'
    ).first();
    await dropdown.waitFor({ state: 'visible', timeout: 5000 });

    // Click the first result
    const firstResult = dropdown.locator('li, [role="option"]').first();
    await firstResult.waitFor({ state: 'visible', timeout: 3000 });
    await firstResult.click();

    console.log(`Inserted @mention: ${displayName}`);
    return true;
  } catch {
    console.warn(`@mention dropdown did not appear for "${displayName}" — using plain text fallback.`);
    // Clear the typed @searchTerm before falling back
    const typed = `@${searchTerm}`;
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
