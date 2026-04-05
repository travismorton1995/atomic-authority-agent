import { Telegraf } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { approvePost, rejectPost, cancelPost, clearPostImage } from './queue.js';
import { pickScheduledTime } from '../scheduler/windows.js';
import type { PendingPost } from './queue.js';
import { getPendingReply, updateReplyStatus, type PendingReply } from './comment-queue.js';
import { postCommentReply, postOutboundComment } from '../poster/comments.js';
import { renewSession } from '../poster/index.js';
import { getPendingComment, updateCommentStatus, addProfile, incrementDailyCount, popFallbackCandidate, addPendingComment, markPostSeen, type PendingComment } from '../outbound/outbound-queue.js';
import { generateOutboundComment } from '../outbound/generate-comment.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot: Telegraf | null = null;

// Resolvers registered by waitForAction — called when a post is approved or rejected
const pendingResolutions = new Map<string, (action: 'approved' | 'rejected' | 'cancelled') => void>();

export function waitForAction(postId: string): Promise<'approved' | 'rejected' | 'cancelled'> {
  return new Promise((resolve) => {
    pendingResolutions.set(postId, resolve);
  });
}

// Optional handler called after a rejection — used by scheduler to auto-regenerate
let onRejectHandler: (() => Promise<void>) | null = null;
let onGenerateHandler: (() => Promise<void>) | null = null;
let onPollHandler: (() => Promise<void>) | null = null;
let onOutboundHandler: (() => Promise<void>) | null = null;

export function setOnRejectHandler(handler: () => Promise<void>): void {
  onRejectHandler = handler;
}

export function setOnGenerateHandler(handler: () => Promise<void>): void {
  onGenerateHandler = handler;
}

export function setOnPollHandler(handler: () => Promise<void>) : void {
  onPollHandler = handler;
}

let onMetricsHandler: (() => Promise<void>) | null = null;
let onRewriteHandler: ((postId: string) => Promise<void>) | null = null;

export function setOnMetricsHandler(handler: () => Promise<void>): void {
  onMetricsHandler = handler;
}

export function setOnRewriteHandler(handler: (postId: string) => Promise<void>): void {
  onRewriteHandler = handler;
}

export function setOnOutboundHandler(handler: () => Promise<void>): void {
  onOutboundHandler = handler;
}

export function startBot(): void {
  if (!token || !chatId) {
    console.warn('Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    return;
  }

  bot = new Telegraf(token);

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*Atomic Authority — Bot Commands*\n\n' +
      '/generate — Run the content pipeline and generate a new draft\n' +
      '/poll — Run a comment reply poll (checks for new comments on your posts)\n' +
      '/outbound — Run the outbound engagement poll (finds posts to comment on)\n' +
      '/metrics — Fetch engagement metrics for all published posts\n' +
      '/login — Open a browser to renew your LinkedIn session\n' +
      '/help — Show this message\n\n' +
      '*Other actions:*\n' +
      '• Send a LinkedIn profile URL to add it to the outbound tracking list',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('generate', async (ctx) => {
    if (!onGenerateHandler) { await ctx.reply('Generator not available.'); return; }
    console.log('Telegram /generate command received');
    await ctx.reply('Running content pipeline...').catch(err => console.error('[/generate] Failed to send reply:', err));
    onGenerateHandler()
      .then((status: any) => {
        if (status === 'already_running') {
          ctx.reply('Pipeline is already running — try again shortly.').catch(() => {});
        }
        // On success, notifyTelegram fires from within the pipeline with the draft
        // On failure, sendAlert fires from within runGenerate
      })
      .catch(err => {
        console.error('[/generate] Unexpected error:', err);
        ctx.reply(`Pipeline failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('poll', async (ctx) => {
    if (!onPollHandler) { await ctx.reply('Poll not available.'); return; }
    console.log('Telegram /poll command received');
    await ctx.reply('Running comment poll...').catch(err => console.error('[/poll] Failed to send reply:', err));
    onPollHandler()
      .then((stats: any) => {
        if (stats?.error === 'already running') {
          ctx.reply('Comment poll is already running — try again shortly.').catch(() => {});
        } else if (stats?.error) {
          ctx.reply(`Comment poll failed: ${stats.error}`).catch(() => {});
        } else if (stats) {
          ctx.reply(`Comment poll complete — ${stats.postsChecked} post(s) in last 14 days, ${stats.totalComments} comment(s) found, ${stats.newComments} new.`).catch(() => {});
        }
      })
      .catch(err => {
        console.error('[/poll] Unexpected error:', err);
        ctx.reply(`Comment poll failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('outbound', async (ctx) => {
    if (!onOutboundHandler) { await ctx.reply('Outbound poll not available.'); return; }
    console.log('Telegram /outbound command received');
    await ctx.reply('Running outbound poll...').catch(err => console.error('[/outbound] Failed to send reply:', err));
    onOutboundHandler()
      .then(() => ctx.reply('Outbound poll complete.').catch(() => {}))
      .catch(err => {
        console.error('[/outbound] Poll error:', err);
        ctx.reply(`Outbound poll failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('metrics', async (ctx) => {
    if (!onMetricsHandler) { await ctx.reply('Metrics fetch not available.'); return; }
    console.log('Telegram /metrics command received');
    await ctx.reply('Fetching engagement metrics...').catch(err => console.error('[/metrics] Failed to send reply:', err));
    onMetricsHandler()
      .then(() => ctx.reply('Metrics fetch complete.').catch(() => {}))
      .catch(err => {
        console.error('[/metrics] Fetch error:', err);
        ctx.reply(`Metrics fetch failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('login', async (ctx) => {
    console.log('Telegram /login command received');
    await ctx.reply('Opening browser for LinkedIn login — check your screen...').catch(err => console.error('[/login] Failed to send reply:', err));
    try {
      const success = await renewSession();
      if (success) {
        console.log('LinkedIn session renewed successfully via /login');
        await ctx.reply('✅ LinkedIn session is active.').catch(err => console.error('[/login] Failed to send success reply:', err));
      } else {
        console.warn('LinkedIn /login timed out — session not renewed');
        await ctx.reply('❌ Login timed out. Try again.').catch(err => console.error('[/login] Failed to send timeout reply:', err));
      }
    } catch (err: any) {
      console.error('[/login] renewSession error:', err);
      await ctx.reply(`❌ Login failed: ${err.message}`).catch(() => {});
    }
  });

  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as any).data as string;
    if (!data) return;

    const firstColon = data.indexOf(':');
    const action = data.slice(0, firstColon);
    const payload = data.slice(firstColon + 1);

    try {
      if (action === 'approve') {
        const scheduledFor = pickScheduledTime();
        const post = approvePost(payload, scheduledFor);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
          timeZone: 'America/Toronto',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        });
        await ctx.answerCbQuery('Approved!');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply(`Post approved. Scheduled for ${scheduledStr}.`);
        pendingResolutions.get(payload)?.('approved');
        pendingResolutions.delete(payload);
      }

      if (action === 'approve_no_image') {
        clearPostImage(payload);
        const scheduledFor = pickScheduledTime();
        const post = approvePost(payload, scheduledFor);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
          timeZone: 'America/Toronto',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        });
        await ctx.answerCbQuery('Approved (no image)!');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply(`Post approved (text only). Scheduled for ${scheduledStr}.`);
        pendingResolutions.get(payload)?.('approved');
        pendingResolutions.delete(payload);
      }

      if (action === 'reject') {
        const post = rejectPost(payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        await ctx.answerCbQuery('Rejected.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        pendingResolutions.get(payload)?.('rejected');
        pendingResolutions.delete(payload);

        if (onRejectHandler) {
          await ctx.reply('Post rejected. Generating a replacement...');
          onRejectHandler().catch(err => {
            console.error('Failed to generate replacement after rejection:', err);
            ctx.reply('Failed to generate a replacement. Check the logs.').catch(() => {});
          });
        } else {
          await ctx.reply('Post rejected.');
        }
      }

      if (action === 'rewrite') {
        if (!onRewriteHandler) { await ctx.answerCbQuery('Rewrite not available.'); return; }
        await ctx.answerCbQuery('Rewriting...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('Rewriting post with fresh hooks and text...');
        console.log(`Rewrite requested for post ${payload}`);
        onRewriteHandler(payload).catch(err => {
          console.error('[rewrite] Failed:', err);
          ctx.reply(`Rewrite failed: ${err.message}`).catch(() => {});
        });
      }

      if (action === 'cancel') {
        const post = cancelPost(payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        console.log(`Post ${payload} cancelled and removed.`);
        await ctx.answerCbQuery('Cancelled.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('Post cancelled and removed.');
        pendingResolutions.get(payload)?.('cancelled');
        pendingResolutions.delete(payload);
      }

      // --- Comment reply flow ---

      if (action === 'cr_select') {
        const lastColon = payload.lastIndexOf(':');
        const replyId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2 | 3;
        const reply = getPendingReply(replyId);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        const selectedText = reply.replyOptions[optionIdx - 1];
        const selectedLabel = reply.replyLabels?.[optionIdx - 1] ?? `option ${optionIdx}`;
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `💬 *Reply preview* | ${reply.postType} | _${selectedLabel}_\n\n"${selectedText}"`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Send', callback_data: `cr_confirm:${replyId}:${optionIdx}` },
                { text: '↩ Back', callback_data: `cr_back:${replyId}` },
              ]],
            },
          },
        );
      }

      if (action === 'cr_confirm') {
        const lastColon = payload.lastIndexOf(':');
        const replyId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2 | 3;
        const reply = getPendingReply(replyId);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        if (reply.status === 'replied') { await ctx.answerCbQuery('Already posted.'); return; }
        await ctx.answerCbQuery('Posting reply…');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        let postErr: Error | null = null;
        try {
          await postCommentReply(reply.postUrl, reply.commentId, reply.replyOptions[optionIdx - 1]);
          updateReplyStatus(replyId, { status: 'replied', selectedOption: optionIdx, repliedAt: new Date().toISOString() });
          console.log(`Comment reply posted — ${reply.commentAuthor} | ${reply.postUrl}`);
        } catch (err: any) {
          postErr = err;
          console.error('[cr_confirm] postCommentReply failed:', err);
        }
        if (postErr) {
          await ctx.editMessageText(
            `❌ *Failed to post reply*\n\n${postErr.message}\n\nYou can try again or skip.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '↩ Try again', callback_data: `cr_back:${replyId}` },
                  { text: '⏭ Skip', callback_data: `cr_skip:${replyId}` },
                ]],
              },
            },
          );
        } else {
          await ctx.editMessageText(
            `✅ *Reply posted* | ${reply.postType}\n\nReplied to ${reply.commentAuthor}.\n\n${reply.postUrl}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } },
          );
        }
      }

      if (action === 'cr_back') {
        const reply = getPendingReply(payload);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          formatCommentMessage(reply),
          { parse_mode: 'Markdown', reply_markup: buildCommentKeyboard(reply) },
        );
      }

      if (action === 'cr_skip') {
        updateReplyStatus(payload, { status: 'skipped' });
        await ctx.answerCbQuery('Skipped.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      }

      // --- Outbound comment flow ---

      if (action === 'oc_select') {
        const lastColon = payload.lastIndexOf(':');
        const commentId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2;
        const comment = getPendingComment(commentId);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        const selectedText = comment.commentOptions[optionIdx - 1];
        const selectedLabel = comment.commentLabels[optionIdx - 1] ?? `option ${optionIdx}`;
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `📤 *Outbound preview* | _${selectedLabel}_\n\n"${selectedText}"`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Post', callback_data: `oc_confirm:${commentId}:${optionIdx}` },
                { text: '↩ Back', callback_data: `oc_back:${commentId}` },
              ]],
            },
          },
        );
      }

      if (action === 'oc_confirm') {
        const lastColon = payload.lastIndexOf(':');
        const commentId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2;
        const comment = getPendingComment(commentId);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        if (comment.status === 'posted') { await ctx.answerCbQuery('Already posted.'); return; }
        await ctx.answerCbQuery('Posting comment…');
        // Remove buttons immediately so the user can't double-tap while the browser runs
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        let postErr: Error | null = null;
        try {
          await postOutboundComment(comment.postUrl, comment.commentOptions[optionIdx - 1]);
          updateCommentStatus(commentId, { status: 'posted', selectedOption: optionIdx, postedAt: new Date().toISOString() });
          incrementDailyCount();
          console.log(`Outbound comment posted — ${comment.profileName} | ${comment.postUrl}`);
        } catch (err: any) {
          postErr = err;
          console.error('[oc_confirm] postOutboundComment failed:', err);
        }
        if (postErr) {
          await ctx.editMessageText(
            `❌ *Failed to post comment*\n\n${postErr.message}\n\nYou can try again or skip.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '↩ Try again', callback_data: `oc_back:${commentId}` },
                  { text: '⏭ Skip', callback_data: `oc_skip:${commentId}` },
                ]],
              },
            },
          );
        } else {
          await ctx.editMessageText(
            `✅ *Comment posted* | ${comment.profileName}\n\n${comment.postUrl}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } },
          );
        }
      }

      if (action === 'oc_back') {
        const comment = getPendingComment(payload);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          formatOutboundMessage(comment),
          { parse_mode: 'Markdown', reply_markup: buildOutboundKeyboard(comment) },
        );
      }

      if (action === 'oc_skip') {
        console.log(`[oc_skip] Skipping comment ${payload}`);
        updateCommentStatus(payload, { status: 'skipped' });
        await ctx.answerCbQuery('Skipped.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const next = popFallbackCandidate();
        if (!next) {
          console.log('[oc_skip] No fallback candidate available.');
          await ctx.reply('No more posts to show.').catch(() => {});
          return;
        }

        markPostSeen(next.id);
        console.log(`[oc_skip] Generating comment for fallback: ${next.profileName} | ${next.url}`);
        await ctx.reply('Generating next option...').catch(() => {});

        let nextGenerated;
        try {
          nextGenerated = await generateOutboundComment(
            { text: next.text, authorName: next.authorName, url: next.url },
            { insider: next.insider, colleague: next.colleague },
          );
        } catch (err: any) {
          console.error('[oc_skip] Failed to generate fallback comment:', err);
          await ctx.reply(`Could not generate comment for next post: ${err.message}`).catch(() => {});
          return;
        }

        const nextComment: PendingComment = {
          id: `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          profileUrl: next.profileUrl,
          profileName: next.profileName,
          postUrl: next.url,
          postSnippet: next.text.split('\n')[0].slice(0, 100),
          postSummary: nextGenerated.postSummary,
          postAgeHours: next.ageHours,
          commentOptions: [nextGenerated.options[0].text, nextGenerated.options[1].text],
          commentLabels: [nextGenerated.options[0].label, nextGenerated.options[1].label],
          recommendationReason: nextGenerated.recommendationReason,
          reasoning: nextGenerated.reasoning,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        addPendingComment(nextComment);
        console.log(`[oc_skip] Sending fallback comment notification for ${next.profileName}`);
        await notifyOutboundComment(nextComment);
      }

    } catch (err: any) {
      if (err?.response?.error_code === 400) {
        // Callback query expired — safe to ignore, happens when a new session
        // picks up button presses from a previous generate run
        return;
      }
      console.error('Unexpected error handling callback query:', err);
    }
  });

  // Launch with retry — Telegram returns 409 if a previous polling session is still active.
  // Retry on the same bot instance (handlers are preserved) until the old session expires.
  (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await bot!.launch();
        return;
      } catch (err: any) {
        const is409 = err?.response?.error_code === 409 || String(err?.message).includes('409');
        if (is409 && attempt < 5) {
          console.warn(`Telegram 409 conflict (attempt ${attempt}/5) — retrying in 10s...`);
          await new Promise(r => setTimeout(r, 10_000));
        } else {
          console.error('Telegram bot failed to launch:', err);
          return;
        }
      }
    }
  })();
  console.log('Telegram bot started.');

  // LinkedIn profile URL listener — send a profile URL to the bot to add it to the outbound list
  bot.on('message', async (ctx) => {
    const text = (ctx.message as any).text as string | undefined;
    if (!text) return;
    const urlMatch = text.match(/https:\/\/www\.linkedin\.com\/(in|company)\/[^\s?#]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];
    const { profile, existed } = addProfile(url);
    if (existed) {
      await ctx.reply(`Already tracking: ${profile.name} (${profile.url})`);
    } else {
      await ctx.reply(`✅ Added to outbound list: ${profile.name}\n${profile.url}`);
    }
  });

  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

export async function sendAlert(message: string): Promise<void> {
  if (!token || !chatId) {
    console.warn(`[ALERT] ${message}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, `⚠️ *Atomic Authority Alert*\n\n${message}`, {
    parse_mode: 'Markdown',
  });
}

export async function sendMessage(message: string): Promise<void> {
  if (!token || !chatId) {
    console.log(`[REPORT]\n${message}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

export async function notifyTelegram(post: PendingPost): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- TELEGRAM NOTIFICATION (not configured) ---');
    console.log(formatMessage(post));
    console.log('----------------------------------------------\n');
    return;
  }

  const sender = new Telegraf(token);
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 15 * 1000;

  // Send image preview first if available (non-fatal if it fails)
  if (post.draft.imageUrl) {
    try {
      await sender.telegram.sendPhoto(chatId, post.draft.imageUrl);
    } catch {
      // Non-fatal — some image URLs may be inaccessible to Telegram's servers
    }
  }

  const keyboard = post.draft.imageUrl
    ? [
        [{ text: '✅ Approve', callback_data: `approve:${post.id}` }],
        [{ text: '🚫 Approve (no image)', callback_data: `approve_no_image:${post.id}` }],
        [{ text: '🔄 Rewrite', callback_data: `rewrite:${post.id}` }],
        [{ text: '❌ Reject', callback_data: `reject:${post.id}` }],
        [{ text: '🗑 Cancel', callback_data: `cancel:${post.id}` }],
      ]
    : [
        [
          { text: '✅ Approve', callback_data: `approve:${post.id}` },
          { text: '🔄 Rewrite', callback_data: `rewrite:${post.id}` },
        ],
        [
          { text: '❌ Reject', callback_data: `reject:${post.id}` },
          { text: '🗑 Cancel', callback_data: `cancel:${post.id}` },
        ],
      ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sender.telegram.sendMessage(chatId, formatMessage(post), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    } catch (err: any) {
      const isNetwork = err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.type === 'system';
      if (isNetwork && attempt < MAX_RETRIES) {
        console.warn(`Telegram send failed (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
}

function getNextCandidatesSummary(): string {
  try {
    if (!existsSync('candidates.json')) return '';
    const store = JSON.parse(readFileSync('candidates.json', 'utf-8'));
    const next = (store.candidates as any[]).slice(store.nextIndex, store.nextIndex + 2);
    if (next.length === 0) return '';
    const lines = next.map((c: any, i: number) => {
      const b = c.scoreBreakdown;
      const bStr = b ? ` (I:${b.intersection} N:${b.novelty} G:${b.geography})` : '';
      return `  #${store.nextIndex + i + 1} · ${c.articleScore}/10${bStr} · "${c.item.title.slice(0, 50)}" _(${c.postType})_`;
    });
    return `\n\n*If rejected, next up:*\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function formatMessage(post: PendingPost): string {
  const cringeNote = post.screening.cringeScore > 3
    ? `Cringe: ${post.screening.cringeScore}/10 — auto-revised`
    : `Cringe: ${post.screening.cringeScore}/10 — clean`;

  const commentSection = post.draft.firstComment
    ? `\n\n*First comment:*\n${post.draft.firstComment}`
    : '';

  const sourceDateStr = post.draft.sourceDate
    ? new Date(post.draft.sourceDate).toLocaleDateString('en-US', {
        timeZone: 'America/Toronto',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const sourceNote = sourceDateStr
    ? `*Source:* ${post.draft.sourceTitle} _(${sourceDateStr})_`
    : `*Source:* ${post.draft.sourceTitle}`;

  const feedNote = post.draft.sourceFeed ? `*Feed:* ${post.draft.sourceFeed}` : '';
  const bd = post.draft.scoreBreakdown;
  const bdStr = bd ? ` (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx})` : '';
  const multiplierStr = (post.draft.balanceMultiplier !== undefined && post.draft.recencyMultiplier !== undefined && post.draft.postContentFeedback !== undefined)
    ? ` × B:${post.draft.balanceMultiplier.toFixed(2)} R:${post.draft.recencyMultiplier.toFixed(2)} P:${post.draft.postContentFeedback.toFixed(2)}`
    : '';
  const scoreNote = post.draft.combinedScore !== undefined
    ? `*Score:* ${post.draft.combinedScore.toFixed(2)}${bdStr}${multiplierStr}`
    : '';
  const metaLine = [feedNote, scoreNote].filter(Boolean).join(' | ');

  const displayContent = post.finalContent.replace(/\[\[MENTION:([^\]]+)\]\]/g, '*$1*');

  return `*New draft ready* | ${post.draft.postType} | ${cringeNote}

${sourceNote}${metaLine ? `\n${metaLine}` : ''}

${displayContent}${commentSection}${getNextCandidatesSummary()}`;
}

// --- Comment reply notification ---

function buildCommentKeyboard(reply: PendingReply) {
  return {
    inline_keyboard: [
      [
        { text: '1️⃣', callback_data: `cr_select:${reply.id}:1` },
        { text: '2️⃣', callback_data: `cr_select:${reply.id}:2` },
        { text: '3️⃣', callback_data: `cr_select:${reply.id}:3` },
        { text: '⏭ Skip', callback_data: `cr_skip:${reply.id}` },
      ],
    ],
  };
}

function formatCommentMessage(reply: PendingReply): string {
  const threadLabel = reply.isReply ? 'reply-to-reply' : 'comment';
  const reasoningSection = reply.reasoning
    ? `\n*AI reasoning:* _${reply.reasoning}_\n`
    : '';

  return `💬 *New ${threadLabel}* | ${reply.postType}
_"${reply.postSnippet}…"_

*From:* ${reply.commentAuthor} _(${reply.commentType})_
"${reply.commentText}"
${reasoningSection}
*Reply options:*
1. ⭐ _${reply.replyLabels?.[0] ?? 'option 1'}:_ ${reply.replyOptions[0]}${reply.recommendationReason ? `\n   _↳ ${reply.recommendationReason}_` : ''}

2. _${reply.replyLabels?.[1] ?? 'option 2'}:_ ${reply.replyOptions[1]}

3. _${reply.replyLabels?.[2] ?? 'option 3'}:_ ${reply.replyOptions[2]}`;
}

// --- Outbound comment notification ---

function buildOutboundKeyboard(comment: PendingComment) {
  return {
    inline_keyboard: [[
      { text: '1️⃣', callback_data: `oc_select:${comment.id}:1` },
      { text: '2️⃣', callback_data: `oc_select:${comment.id}:2` },
      { text: '⏭ Skip', callback_data: `oc_skip:${comment.id}` },
    ]],
  };
}

function formatOutboundMessage(comment: PendingComment): string {
  const ageLabel = comment.postAgeHours !== null && comment.postAgeHours !== undefined
    ? `${comment.postAgeHours.toFixed(1)}h ago`
    : 'unknown age';
  const goldenWindow = comment.postAgeHours !== null && comment.postAgeHours !== undefined && comment.postAgeHours < 2;
  const summarySection = comment.postSummary ? `\n*Post:* _${comment.postSummary}_\n` : '';
  const whySection = comment.reasoning ? `\n*Why:* _${comment.reasoning}_\n` : '';

  return `📤 *Outbound comment* | ${comment.profileName} | _${ageLabel}${goldenWindow ? ' ⚡' : ''}_
_"${comment.postSnippet}…"_
${summarySection}${whySection}
*Comment options:*
1. ⭐ _${comment.commentLabels[0]}:_ ${comment.commentOptions[0]}${comment.recommendationReason ? `\n   _↳ ${comment.recommendationReason}_` : ''}

2. _${comment.commentLabels[1]}:_ ${comment.commentOptions[1]}`;
}

export async function notifyOutboundComment(comment: PendingComment): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- OUTBOUND COMMENT (not configured) ---');
    console.log(formatOutboundMessage(comment));
    console.log('-----------------------------------------\n');
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, formatOutboundMessage(comment), {
    parse_mode: 'Markdown',
    reply_markup: buildOutboundKeyboard(comment),
  });
}

export async function notifyCommentReply(reply: PendingReply): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- COMMENT REPLY (not configured) ---');
    console.log(formatCommentMessage(reply));
    console.log('--------------------------------------\n');
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, formatCommentMessage(reply), {
    parse_mode: 'Markdown',
    reply_markup: buildCommentKeyboard(reply),
  });
}
