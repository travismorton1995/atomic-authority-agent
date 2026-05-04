import { chromium } from 'playwright';
import path from 'path';
import crypto from 'crypto';
import { isSessionExpiredUrl } from './index.js';
import { acquireBrowserLock } from './browser-lock.js';

const USER_DATA_DIR = path.resolve('user_data');

export interface ScrapedComment {
  id: string;       // LinkedIn comment URN (data-id) or MD5 hash fallback
  author: string;
  text: string;
  isReply: boolean;
}

export async function scrapeComments(postUrl: string): Promise<ScrapedComment[]> {
  const release = await acquireBrowserLock();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (isSessionExpiredUrl(page.url())) {
      throw new Error('LinkedIn session expired — run /login to renew');
    }
    // Wait for the post to lazy-load (LinkedIn SPA hydrates after DCL)
    await page.waitForSelector(
      'article, main [class*="feed-shared"], div[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:ugcPost:"]',
      { timeout: 20000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Expand the comments section (click the comment count button)
    const expandBtn = page.locator('button[aria-label*="comment on"]').first();
    if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expandBtn.click();
      await page.waitForTimeout(2000);
    }

    // Switch sort to "Most recent" — surfaces our low-engagement comments
    const sortBtn = page.locator(
      'button[aria-label*="Sort comments"], button.comments-sort-dropdown__trigger-text-wrapper'
    ).first();
    if (await sortBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sortBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      const recentOption = page.locator('div[role="menuitem"], li[role="menuitem"], button')
        .filter({ hasText: /^Most recent$/i }).first();
      if (await recentOption.isVisible({ timeout: 1500 }).catch(() => false)) {
        await recentOption.click().catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    // Load more top-level comments if paginated
    for (let i = 0; i < 10; i++) {
      const btn = page.locator(
        'button[aria-label*="Load more comments"], ' +
        'button[aria-label*="Show more comments"], ' +
        'button[aria-label*="Show previous comments"]'
      ).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1200);
      } else {
        break;
      }
    }

    // Expand reply threads. Multiple passes — aria-label AND text-based since
    // LinkedIn redesigned buttons may lack aria-label.
    for (let pass = 0; pass < 5; pass++) {
      let clicked = 0;
      const ariaBtns = page.locator(
        'button[aria-label*="repl" i], button[aria-label*="See previous" i], button[aria-label*="See more" i]'
      );
      const ariaCount = await ariaBtns.count();
      for (let i = 0; i < ariaCount; i++) {
        if (await ariaBtns.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
          await ariaBtns.nth(i).click().catch(() => {});
          await page.waitForTimeout(700);
          clicked++;
        }
      }
      for (const re of [
        /^See previous repl(y|ies)$/i,
        /^See more repl(y|ies)$/i,
        /^Show \d+ (more )?repl(y|ies)$/i,
      ]) {
        const targets = page.getByText(re);
        const count = await targets.count();
        for (let i = 0; i < count; i++) {
          if (await targets.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
            await targets.nth(i).click().catch(() => {});
            await page.waitForTimeout(700);
            clicked++;
          }
        }
      }
      if (clicked === 0) break;
    }

    // Text-based parser. LinkedIn (May 2026) stripped all structural attrs
    // and class names from comments. We anchor on the comment composer,
    // take text after it, then identify each commenter by either a degree
    // marker line or a line matching our display name (own comments have
    // no degree). See monitor-replies.ts for the same approach.
    const myDisplayName = process.env.LINKEDIN_DISPLAY_NAME ?? '';
    const rawComments = await page.evaluate((displayName) => {
      let scopedText = '';
      const editor = document.querySelector('[aria-label="Text editor for creating comment"]')
        || document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
      if (editor) {
        const range = document.createRange();
        range.setStartAfter(editor);
        range.setEndAfter(document.body);
        const frag = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(frag);
        document.body.appendChild(div);
        scopedText = (div as HTMLElement).innerText ?? '';
        div.remove();
      } else {
        scopedText = document.body?.innerText ?? '';
      }
      const lines = scopedText.split('\n');

      const rawBoundaries: { idx: number; reason: string }[] = [];
      const nameLower = displayName.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^[·•]\s*(1st|2nd|3rd\+?)$/i.test(t)) { rawBoundaries.push({ idx: i, reason: 'degree' }); continue; }
        if (/^Author$/.test(t)) { rawBoundaries.push({ idx: i, reason: 'author' }); continue; }
        // Inline format: "Name • 2nd" or "Name  2nd" — name + degree on same line
        if (/[A-Za-z][^\n]*?(\s[·•]\s*|\s{2,})(1st|2nd|3rd\+?)$/i.test(t) && t.length < 120) {
          rawBoundaries.push({ idx: i, reason: 'degree-inline' });
          continue;
        }
        if (nameLower && t.length > 0 && t.length < 80) {
          const tLower = t.toLowerCase();
          if (tLower === nameLower) { rawBoundaries.push({ idx: i, reason: 'self' }); continue; }
          if (tLower.includes(nameLower) && /\bYou\b/.test(t)) { rawBoundaries.push({ idx: i, reason: 'self-you' }); continue; }
        }
      }
      // Filter spurious self matches that are quotes inside other comments
      const TIMESTAMP_PROBE = /^(now|just now|\d+\s*(yr|mo|w|wk|d|h|m|s|sec|min|hr|day|week|month|year)s?)$/i;
      const filteredBoundaries: { idx: number; reason: string }[] = [];
      for (const b of rawBoundaries) {
        if (b.reason === 'degree' || b.reason === 'degree-inline' || b.reason === 'author') {
          filteredBoundaries.push(b);
          continue;
        }
        let validHeader = false;
        for (let j = b.idx + 1; j < Math.min(b.idx + 7, lines.length); j++) {
          const l = lines[j].trim();
          if (!l) continue;
          if (/^Author$/.test(l)) { validHeader = true; break; }
          if (/^Follow(ing)?$/i.test(l)) { validHeader = true; break; }
          if (TIMESTAMP_PROBE.test(l)) { validHeader = true; break; }
          if (TIMESTAMP_PROBE.test(l.replace(/\(?\s*edited\s*\)?/gi, '').replace(/\s*[·•]\s*/g, ' ').trim())) { validHeader = true; break; }
        }
        if (validHeader) filteredBoundaries.push(b);
      }
      const boundaries: { idx: number; reason: string }[] = [];
      for (const b of filteredBoundaries) {
        const last = boundaries[boundaries.length - 1];
        if (last && b.idx - last.idx <= 4) continue;
        boundaries.push(b);
      }

      interface Parsed { id: string; author: string; text: string; isReply: boolean }
      const comments: Parsed[] = [];
      const TIMESTAMP_RE = /^(now|just now|\d+\s*(yr|mo|w|wk|d|h|m|s|sec|min|hr|day|week|month|year)s?)$/i;

      for (let bi = 0; bi < boundaries.length; bi++) {
        const { idx: boundary, reason } = boundaries[bi];
        const nextBoundary = boundaries[bi + 1]?.idx ?? lines.length;
        let rawAuthor = '';
        if (reason === 'self' || reason === 'self-you' || reason === 'degree-inline') {
          rawAuthor = lines[boundary];
        } else {
          for (let j = boundary - 1; j >= Math.max(0, boundary - 4); j--) {
            const l = lines[j].trim();
            if (!l) continue;
            if (/^(Premium Profile|Influencer|Author|Following|Verified Profile)$/i.test(l)) continue;
            rawAuthor = l;
            break;
          }
        }
        const author = rawAuthor
          .replace(/\bVerified Profile\b/gi, '')
          .replace(/\bPremium Profile\b/gi, '')
          .replace(/\bInfluencer\b/gi, '')
          .replace(/\bFollowing\b/gi, '')
          .replace(/\bAuthor\b/g, '')
          .replace(/\bYou\b/g, '')
          .replace(/\s*[·•]\s*(1st|2nd|3rd\+?)\s*$/gi, '')
          .replace(/\s*(1st|2nd|3rd\+?)\s*$/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!author) continue;

        const textLines: string[] = [];
        let inContent = false;
        let sawAnyContent = false;
        for (let j = boundary + 1; j < nextBoundary; j++) {
          const l = lines[j].trim();
          if (/^Like$/i.test(l)) break;
          if (/^Reply$/i.test(l)) break;
          if (/^Like\s*[·•]?\s*Reply/i.test(l)) break;
          if (/^\d+\s*reactions?$/i.test(l)) break;
          if (/^\d+\s*repl(y|ies)$/i.test(l)) break;
          if (/^Show\s+\d+\s+(more\s+)?(reply|replies|comments)/i.test(l)) break;
          if (/^See (previous|more) repl(y|ies)$/i.test(l)) break;
          if (/^Load more comments?$/i.test(l)) break;
          if (/^\d+\s*impressions?$/i.test(l)) break;
          if (/^About$/.test(l) || /^Accessibility$/.test(l) || /^Help Center$/.test(l)) break;
          if (/^LinkedIn Corporation/.test(l)) break;
          if (/^©/.test(l)) break;
          if (!l) { if (sawAnyContent) textLines.push(''); continue; }
          // Match bare timestamp OR one with "(edited)" prefix/suffix
          if (TIMESTAMP_RE.test(l) || TIMESTAMP_RE.test(l.replace(/\(?\s*edited\s*\)?/gi, '').replace(/\s*[·•]\s*/g, ' ').trim())) { inContent = true; continue; }
          if (!inContent) continue;
          if (/^Follow(ing)?$/i.test(l)) continue;
          if (/^[•·]\s*You$/i.test(l)) continue;
          if (/^You$/i.test(l)) continue;
          if (sawAnyContent && /^\d{1,4}$/.test(l)) continue;
          textLines.push(l);
          sawAnyContent = true;
        }
        const commentText = textLines.join('\n').trim();
        if (!commentText) continue;
        const idSeed = `${author}|${commentText.slice(0, 80)}`;
        let hash = 0;
        for (let k = 0; k < idSeed.length; k++) {
          hash = ((hash << 5) - hash + idSeed.charCodeAt(k)) | 0;
        }
        const id = `txt_${Math.abs(hash).toString(36)}`;
        comments.push({ id, author, text: commentText, isReply: false });
      }
      return comments;
    }, myDisplayName);

    return rawComments.map(c => ({
      id: c.id,
      author: c.author,
      text: c.text,
      isReply: c.isReply,
    }));
  } finally {
    await context.close();
    release();
  }
}

export async function postCommentReply(
  postUrl: string,
  commentId: string,
  replyText: string
): Promise<void> {
  const release = await acquireBrowserLock();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  try {
    console.log(`Comment reply: navigating to post...`);
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

    // Expand reply threads. Multiple passes — aria-label AND text-based since
    // LinkedIn redesigned buttons may lack aria-label.
    for (let pass = 0; pass < 5; pass++) {
      let clicked = 0;
      const ariaBtns = page.locator(
        'button[aria-label*="repl" i], button[aria-label*="See previous" i], button[aria-label*="See more" i]'
      );
      const ariaCount = await ariaBtns.count();
      for (let i = 0; i < ariaCount; i++) {
        if (await ariaBtns.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
          await ariaBtns.nth(i).click().catch(() => {});
          await page.waitForTimeout(700);
          clicked++;
        }
      }
      for (const re of [
        /^See previous repl(y|ies)$/i,
        /^See more repl(y|ies)$/i,
        /^Show \d+ (more )?repl(y|ies)$/i,
      ]) {
        const targets = page.getByText(re);
        const count = await targets.count();
        for (let i = 0; i < count; i++) {
          if (await targets.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
            await targets.nth(i).click().catch(() => {});
            await page.waitForTimeout(700);
            clicked++;
          }
        }
      }
      if (clicked === 0) break;
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
    // that LinkedIn pre-fills when the reply box opens (fill() would wipe it).
    // LinkedIn migrated from Quill (.ql-editor) to TipTap/ProseMirror in May 2026.
    // The aria-label is the most stable selector; old classes kept as fallback.
    const composer = page.locator(
      '[aria-label="Text editor for creating comment"], ' +
      '.tiptap.ProseMirror[contenteditable="true"], ' +
      '.comments-comment-texteditor .ql-editor, ' +
      '.comments-comment-box__form .ql-editor'
    ).last();
    await composer.waitFor({ state: 'visible', timeout: 15000 });
    await composer.click();
    await page.keyboard.press('Control+End');
    console.log(`Comment reply: typing reply...`);
    await page.keyboard.type(replyText, { delay: 40 });
    await page.waitForTimeout(500);

    // Submit. Try Ctrl+Enter, verify by checking the reply composer cleared,
    // fall back to clicking a button by text. Verification is critical because
    // a successful keystroke does NOT guarantee submission landed.
    const submitProbe = replyText.slice(0, 30);
    const stillHasReplyText = async (): Promise<boolean> => {
      return await page.evaluate((probe) => {
        const editors = Array.from(document.querySelectorAll(
          '[aria-label="Text editor for creating comment"], ' +
          '.tiptap.ProseMirror[contenteditable="true"], ' +
          '.ql-editor'
        ));
        return editors.some(ed => (ed.textContent ?? '').includes(probe));
      }, submitProbe).catch(() => false);
    };

    // Click the submit button via DOM ancestor walk from the reply composer.
    // For replies, the editor returned by `composer.last()` is the active
    // reply box, so we read its current focused descendant via document.
    const replyClickResult = await page.evaluate(() => {
      // The active reply composer is the most recently rendered/focused one
      const editors = Array.from(document.querySelectorAll(
        '[aria-label="Text editor for creating comment"], ' +
        '.tiptap.ProseMirror[contenteditable="true"], ' +
        '.ql-editor'
      ));
      if (editors.length === 0) return { ok: false, reason: 'no editor' };
      const editor = editors[editors.length - 1] as Element;

      let ancestor: Element | null = editor.parentElement;
      while (ancestor) {
        const btn = Array.from(ancestor.querySelectorAll('button')).find(b => {
          if ((b as HTMLElement).offsetParent === null) return false;
          if ((b as HTMLButtonElement).disabled) return false;
          const txt = (b.textContent ?? '').trim();
          return /^(Reply|Comment|Post)$/i.test(txt);
        });
        if (btn) {
          (btn as HTMLButtonElement).click();
          return { ok: true, reason: `clicked: text="${(btn.textContent ?? '').trim()}"` };
        }
        ancestor = ancestor.parentElement;
      }
      return { ok: false, reason: 'no submit button in any ancestor' };
    }).catch(err => ({ ok: false, reason: `error: ${(err as Error).message}` } as { ok: boolean; reason: string }));

    console.log(`Comment reply: submit ${replyClickResult.ok ? '✓' : '✗'} (${replyClickResult.reason})`);
    await page.waitForTimeout(2500);

    if (!replyClickResult.ok && (await stillHasReplyText())) {
      console.log('Comment reply: ancestor walk failed, trying Ctrl+Enter...');
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(2500);
    }

    if (await stillHasReplyText()) {
      throw new Error('Reply did not submit — editor still contains the typed text after Ctrl+Enter and button-click fallback.');
    }

    console.log(`Comment reply: submitted successfully.`);
  } finally {
    await context.close();
    release();
  }
}

export async function postOutboundComment(
  postUrl: string,
  commentText: string,
): Promise<void> {
  const release = await acquireBrowserLock();
  try {
    // Retry up to 2 times. We re-open the browser context each attempt because
    // a wedged page is the most common cause of timeouts. Critically: the retry
    // boundary is BEFORE the submit click — once we click submit, we don't
    // retry, to avoid double-posting.
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'chrome',
        headless: process.env.LINKEDIN_HEADLESS === 'true',
        locale: 'en-US',
      });
      const page = context.pages()[0] ?? await context.newPage();
      try {
        console.log(`Outbound comment: navigating to post (attempt ${attempt})...`);
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Expand the comments section so the composer becomes active.
        // The new TipTap composer often renders without needing an explicit
        // expand click, but we still try in case it's collapsed.
        const expandBtn = page.locator('button[aria-label*="comment on"]').first();
        if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await expandBtn.click();
          await page.waitForTimeout(1500);
        }

        // Click the main comment composer.
        // LinkedIn migrated from Quill (.ql-editor) to TipTap/ProseMirror in May 2026.
        // The aria-label is the most stable selector; old classes kept as fallback.
        const composer = page.locator(
          '[aria-label="Text editor for creating comment"], ' +
          '.tiptap.ProseMirror[contenteditable="true"], ' +
          '.comments-comment-texteditor .ql-editor, ' +
          '.comments-comment-box__form .ql-editor'
        ).first();
        await composer.waitFor({ state: 'visible', timeout: 15000 });
        await composer.click();
        await page.keyboard.press('Control+End');
        console.log(`Outbound comment: typing comment...`);
        await page.keyboard.type(commentText, { delay: 40 });
        await page.waitForTimeout(1500);

        // Submit. We try Ctrl+Enter first (no selector dependency), then
        // verify by checking whether the editor cleared. If still has text,
        // fall back to clicking a button matching "Comment"/"Post" by text
        // (class names are now obfuscated CSS-module hashes).
        // Past this point: do not retry the whole attempt — submit may have
        // landed and a retry would double-post. Internal fallbacks within
        // this attempt are safe because we verify before each.
        const submitProbe = commentText.slice(0, 30);
        const stillHasText = async (): Promise<boolean> => {
          return await page.evaluate((probe) => {
            const ed = document.querySelector('[aria-label="Text editor for creating comment"]')
              || document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
              || document.querySelector('.ql-editor');
            if (!ed) return false; // editor removed → submitted
            return (ed.textContent ?? '').includes(probe);
          }, submitProbe).catch(() => false);
        };

        // Click the submit button. The new TipTap UI has multiple "Comment"
        // buttons on the page (action bar toggles for our post AND related
        // posts shown below). We must find the one inside OUR composer.
        // Strategy: walk up from the editor and pick the closest ancestor
        // that contains a Comment/Post button — that's our submit button.
        const clickResult = await page.evaluate(() => {
          const editor = document.querySelector('[aria-label="Text editor for creating comment"]')
            || document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
            || document.querySelector('.ql-editor');
          if (!editor) return { ok: false, reason: 'no editor' };

          let ancestor: Element | null = editor.parentElement;
          while (ancestor) {
            const btn = Array.from(ancestor.querySelectorAll('button')).find(b => {
              if ((b as HTMLElement).offsetParent === null) return false;
              if ((b as HTMLButtonElement).disabled) return false;
              const txt = (b.textContent ?? '').trim();
              return /^(Comment|Post)$/i.test(txt);
            });
            if (btn) {
              (btn as HTMLButtonElement).click();
              return { ok: true, reason: `clicked: text="${(btn.textContent ?? '').trim()}"` };
            }
            ancestor = ancestor.parentElement;
          }
          return { ok: false, reason: 'no submit button in any ancestor' };
        }).catch(err => ({ ok: false, reason: `error: ${(err as Error).message}` } as { ok: boolean; reason: string }));

        console.log(`Outbound comment: submit ${clickResult.ok ? '✓' : '✗'} (${clickResult.reason})`);
        await page.waitForTimeout(2500);

        // Fallback: if the ancestor walk couldn't find a button (e.g. UI
        // structure unexpected), try Ctrl+Enter as last resort.
        if (!clickResult.ok && (await stillHasText())) {
          console.log('Outbound comment: ancestor walk failed, trying Ctrl+Enter...');
          await page.keyboard.press('Control+Enter');
          await page.waitForTimeout(2500);
        }

        if (await stillHasText()) {
          // DIAGNOSTIC: dump everything we need to figure out why submit fails.
          // Hypothesis: TipTap/ProseMirror displays our typed text but doesn't
          // register it in its internal state, so the submit button stays
          // disabled and Ctrl+Enter is a no-op.
          try {
            const diag = await page.evaluate(() => {
              const ed = document.querySelector('[aria-label="Text editor for creating comment"]')
                || document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
                || document.querySelector('.ql-editor');
              const editorState = ed ? {
                tag: ed.tagName,
                cls: (ed as HTMLElement).className.slice(0, 120),
                ariaDisabled: ed.getAttribute('aria-disabled'),
                ariaReadonly: ed.getAttribute('aria-readonly'),
                contenteditable: ed.getAttribute('contenteditable'),
                innerText: ((ed as HTMLElement).innerText ?? '').slice(0, 200),
                innerHTML: ed.innerHTML.slice(0, 400),
                hasFocus: document.activeElement === ed,
              } : null;
              // Find ALL buttons matching Comment/Post and report their state
              const submitCandidates = Array.from(document.querySelectorAll('button'))
                .filter(b => {
                  const txt = (b.textContent ?? '').trim();
                  return /^(Comment|Post)$/i.test(txt);
                })
                .map(b => ({
                  text: (b.textContent ?? '').trim(),
                  aria: b.getAttribute('aria-label') ?? '',
                  disabled: (b as HTMLButtonElement).disabled,
                  ariaDisabled: b.getAttribute('aria-disabled'),
                  visible: (b as HTMLElement).offsetParent !== null,
                  cls: (b as HTMLElement).className.slice(0, 60),
                }));
              // Look for visible toast/error/challenge messages
              const possibleAlerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
                .map(e => ((e as HTMLElement).innerText ?? '').trim().slice(0, 120))
                .filter(s => s.length > 0)
                .slice(0, 5);
              return { editorState, submitCandidates, possibleAlerts, url: location.href };
            });
            console.warn(`[diag] editor state: ${JSON.stringify(diag.editorState)}`);
            console.warn(`[diag] submit button candidates: ${JSON.stringify(diag.submitCandidates)}`);
            console.warn(`[diag] alert/status messages: ${JSON.stringify(diag.possibleAlerts)}`);
            console.warn(`[diag] page url: ${diag.url}`);

            // Take a screenshot for visual inspection
            const fs = await import('fs');
            const screenshotDir = 'debug_screenshots';
            if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
            const screenshotPath = `${screenshotDir}/submit_fail_${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
            console.warn(`[diag] screenshot saved: ${screenshotPath}`);
          } catch (diagErr) {
            console.warn(`[diag] failed: ${(diagErr as Error).message}`);
          }
          throw new Error('Comment did not submit — editor still contains the typed text after Ctrl+Enter and button-click fallback.');
        }

        console.log(`Outbound comment: submitted successfully.`);
        await context.close();
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`Outbound comment: attempt ${attempt} failed: ${(err as Error).message}`);
        await context.close().catch(() => {});
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}
