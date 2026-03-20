import { Telegraf } from 'telegraf';
import { approvePost, rejectPost } from './queue.js';
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

  bot.launch();
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

export async function notifyTelegram(post: PendingPost): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- TELEGRAM NOTIFICATION (not configured) ---');
    console.log(formatMessage(post));
    console.log('----------------------------------------------\n');
    return;
  }

  // Send directly via API — no need for the polling bot to be running
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, formatMessage(post), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${post.id}` },
        { text: '❌ Reject', callback_data: `reject:${post.id}` },
      ]],
    },
  });
}

function formatMessage(post: PendingPost): string {
  const cringeNote = post.screening.cringeScore > 3
    ? `Cringe: ${post.screening.cringeScore}/10 — auto-revised`
    : `Cringe: ${post.screening.cringeScore}/10 — clean`;

  const commentSection = post.draft.firstComment
    ? `\n\n*First comment:*\n${post.draft.firstComment}`
    : '';

  return `*New draft ready* | ${post.draft.postType} | ${cringeNote}

*Source:* ${post.draft.sourceTitle}

${post.finalContent}${commentSection}`;
}
