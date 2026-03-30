import { Telegraf } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { approvePost, rejectPost, clearPostImage } from './queue.js';
import { pickScheduledTime } from '../scheduler/windows.js';
import type { PendingPost } from './queue.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot: Telegraf | null = null;

// Resolvers registered by waitForAction — called when a post is approved or rejected
const pendingResolutions = new Map<string, (action: 'approved' | 'rejected') => void>();

export function waitForAction(postId: string): Promise<'approved' | 'rejected'> {
  return new Promise((resolve) => {
    pendingResolutions.set(postId, resolve);
  });
}

// Optional handler called after a rejection — used by scheduler to auto-regenerate
let onRejectHandler: (() => Promise<void>) | null = null;

export function setOnRejectHandler(handler: () => Promise<void>): void {
  onRejectHandler = handler;
}

export function startBot(): void {
  if (!token || !chatId) {
    console.warn('Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    return;
  }

  bot = new Telegraf(token);

  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as any).data as string;
    if (!data) return;

    const [action, id] = data.split(':');

    try {
      if (action === 'approve') {
        const scheduledFor = pickScheduledTime();
        const post = approvePost(id, scheduledFor);
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
        pendingResolutions.get(id)?.('approved');
        pendingResolutions.delete(id);
      }

      if (action === 'approve_no_image') {
        clearPostImage(id);
        const scheduledFor = pickScheduledTime();
        const post = approvePost(id, scheduledFor);
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
        pendingResolutions.get(id)?.('approved');
        pendingResolutions.delete(id);
      }

      if (action === 'reject') {
        const post = rejectPost(id);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        await ctx.answerCbQuery('Rejected.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        pendingResolutions.get(id)?.('rejected');
        pendingResolutions.delete(id);

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
        [{ text: '❌ Reject', callback_data: `reject:${post.id}` }],
      ]
    : [[
        { text: '✅ Approve', callback_data: `approve:${post.id}` },
        { text: '❌ Reject', callback_data: `reject:${post.id}` },
      ]];

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
  const scoreNote = post.draft.combinedScore !== undefined
    ? `*Score:* ${post.draft.combinedScore.toFixed(2)}${bdStr}`
    : '';
  const metaLine = [feedNote, scoreNote].filter(Boolean).join(' | ');

  const displayContent = post.finalContent.replace(/\[\[MENTION:([^\]]+)\]\]/g, '*$1*');

  return `*New draft ready* | ${post.draft.postType} | ${cringeNote}

${sourceNote}${metaLine ? `\n${metaLine}` : ''}

${displayContent}${commentSection}${getNextCandidatesSummary()}`;
}
