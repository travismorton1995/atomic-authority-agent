// Loopback comment activation.
// At 9am ET, checks if yesterday's post has no external comments.
// If so, schedules the loopback comment for 9:30am-12pm ET with random jitter.
// At each cron tick, posts any loopback comments whose scheduled time has arrived.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { scrapeComments, postOutboundComment } from '../poster/comments.js';
import { sendMessage } from '../hitl/telegram.js';

const HISTORY_FILE = 'posted_history.json';

interface HistoryPost {
  id: string;
  status: string;
  publishedAt?: string;
  linkedInPostUrl?: string;
  draft: {
    firstComment?: string;
    loopbackComment?: string;
    postType?: string;
    sourceTitle?: string;
  };
  loopbackStatus?: 'pending' | 'scheduled' | 'posted' | 'skipped' | 'reminder_sent';
  loopbackScheduledFor?: string;
}

function loadHistory(): HistoryPost[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }
}

function saveHistory(history: HistoryPost[]): void {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function updatePost(id: string, updates: Partial<HistoryPost>): void {
  const history = loadHistory();
  const post = history.find(p => p.id === id);
  if (post) {
    Object.assign(post, updates);
    saveHistory(history);
  }
}

/** Pick a random time between 9:30am and 12:00pm ET on a given date. */
function pickLoopbackTime(dateET: string): string {
  // dateET is like "2026-04-29"
  const startMinutes = 9 * 60 + 30; // 9:30am
  const endMinutes = 12 * 60;       // 12:00pm
  const randomMinute = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));
  const hour = Math.floor(randomMinute / 60);
  const minute = randomMinute % 60;

  // Build a date in ET then convert to ISO
  const etStr = `${dateET}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  // Use Intl to get the UTC offset for America/Toronto at this date
  const approxDate = new Date(`${dateET}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(approxDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  // Parse offset like "GMT-4" or "GMT-5"
  const offsetMatch = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : -4;

  const utcDate = new Date(`${etStr}Z`);
  utcDate.setHours(utcDate.getHours() - offsetHours);
  return utcDate.toISOString();
}

/**
 * Check if yesterday's post needs a loopback comment.
 * Called at 9am ET. If the post has a loopback comment and no external engagement,
 * schedule it for 9:30am-12pm ET.
 */
export async function checkLoopbackEligibility(): Promise<void> {
  // Manual-posting flow: no longer scrapes comments. Sends a Telegram
  // reminder for any post published yesterday that has a loopback comment.
  // User checks LinkedIn for external comments and decides whether to paste.
  const history = loadHistory();

  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setDate(yesterdayEnd.getDate() + 1);

  const candidates = history.filter(p =>
    p.status === 'published' &&
    p.publishedAt &&
    p.draft?.loopbackComment &&
    (!p.loopbackStatus || p.loopbackStatus === 'pending') &&
    new Date(p.publishedAt) >= yesterdayStart &&
    new Date(p.publishedAt) < yesterdayEnd
  );

  if (candidates.length === 0) {
    console.log('[loopback] No eligible posts from yesterday.');
    return;
  }

  for (const post of candidates) {
    try {
      const { sendLoopbackReminder } = await import('../hitl/telegram.js');
      await sendLoopbackReminder(post);
      updatePost(post.id, { loopbackStatus: 'reminder_sent' });
      console.log(`[loopback] Reminder sent for "${post.draft.sourceTitle?.slice(0, 40)}..."`);
    } catch (err) {
      console.error(`[loopback] Failed to send reminder: ${(err as Error).message}`);
    }
  }
}

let loopbackPosting = false;

/**
 * Post any loopback comments whose scheduled time has arrived.
 * Called on each cron tick.
 */
export async function postDueLoopbacks(): Promise<void> {
  if (loopbackPosting) return; // prevent double-post if previous tick is still running
  loopbackPosting = true;
  try {
    await _postDueLoopbacks();
  } finally {
    loopbackPosting = false;
  }
}

async function _postDueLoopbacks(): Promise<void> {
  const history = loadHistory();
  const now = new Date().toISOString();

  const due = history.filter(p =>
    p.loopbackStatus === 'scheduled' &&
    p.loopbackScheduledFor &&
    p.loopbackScheduledFor <= now &&
    p.linkedInPostUrl &&
    p.draft?.loopbackComment
  );

  if (due.length === 0) return;

  for (const post of due) {
    // Mark as posting immediately to prevent duplicate from next cron tick
    updatePost(post.id, { loopbackStatus: 'posted' });
    console.log(`[loopback] Posting loopback comment for "${post.draft.sourceTitle?.slice(0, 40)}..."...`);

    try {
      await postOutboundComment(post.linkedInPostUrl!, post.draft.loopbackComment!);
      console.log('[loopback] Loopback comment posted.');
      await sendMessage(
        `🔄 *Loopback comment posted*\n\n_"${post.draft.loopbackComment?.slice(0, 120)}..."_\n\n${post.linkedInPostUrl}`,
      ).catch(() => {});
    } catch (err) {
      console.error(`[loopback] Failed to post: ${(err as Error).message}`);
      await sendMessage(`❌ Loopback comment failed: ${(err as Error).message}`).catch(() => {});
    }
  }
}
