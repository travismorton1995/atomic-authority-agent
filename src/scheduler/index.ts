import 'dotenv/config';
import { initLogger } from '../utils/logger.js';
initLogger();
import cron from 'node-cron';
import { getPostsDueForPublishing, getPendingPosts, markPublished, incrementPublishFailures, cleanupRejectedPosts } from '../hitl/queue.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';

// --- Single-instance lockfile guard ---
const LOCK_FILE = path.resolve('scheduler.lock');

function acquireLock(): void {
  const myPid = process.pid;

  if (existsSync(LOCK_FILE)) {
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // probe — throws if process doesn't exist
        console.error(`Another scheduler is already running (PID ${existingPid}). Exiting.`);
        process.exit(1);
      } catch {
        // Stale lockfile — previous process is dead
        console.warn(`Removing stale lockfile (PID ${existingPid} is gone).`);
      }
    }
  }

  writeFileSync(LOCK_FILE, String(myPid), 'utf-8');
}

function releaseLock(): void {
  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    if (parseInt(raw, 10) === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

function alreadyPostedToday(): boolean {
  if (!existsSync('posted_history.json')) return false;
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    const today = new Date().toDateString();
    return history.some((p: any) => p.publishedAt && new Date(p.publishedAt).toDateString() === today);
  } catch {
    return false;
  }
}
import { postToLinkedIn, pingSession, LinkedInSessionExpiredError } from '../poster/index.js';
import { startBot, sendAlert, sendMessage, setOnRejectHandler, setOnGenerateHandler, setOnPollHandler, setOnOutboundHandler, setOnMetricsHandler, setOnRewriteHandler } from '../hitl/telegram.js';
import { runPipeline, rewritePost } from '../content/pipeline.js';
import { runMetricsFetch, runWeeklyReport } from '../cli/fetch-metrics.js';
import { runCommentPoll, type CommentPollOptions, type CommentPollStats } from '../hitl/comment-poll.js';
import { getLastPollAt } from '../hitl/comment-queue.js';
import { runOutboundPoll } from '../hitl/outbound-poll.js';

const GENERATE_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const GENERATE_NETWORK_RETRY_DELAY_MS = 60 * 1000; // 1 minute
const GENERATE_MAX_RETRIES = 3;

let isGenerating = false;

async function runGenerate(): Promise<'started' | 'already_running'> {
  if (isGenerating) {
    console.log('Pipeline already running — ignoring duplicate trigger.');
    return 'already_running';
  }
  isGenerating = true;
  console.log('Scheduler triggered — running pipeline...');
  try {
    for (let attempt = 1; attempt <= GENERATE_MAX_RETRIES; attempt++) {
      try {
        await runPipeline();
        return 'started';
      } catch (err: any) {
        const isOverloaded = err?.status === 529 || err?.error?.error?.type === 'overloaded_error';
        const isNetworkError = err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.type === 'system';

        if (attempt < GENERATE_MAX_RETRIES && (isOverloaded || isNetworkError)) {
          const delay = isNetworkError ? GENERATE_NETWORK_RETRY_DELAY_MS : GENERATE_RETRY_DELAY_MS;
          const reason = isNetworkError ? 'Network error' : 'Anthropic API overloaded';
          console.warn(`${reason} (attempt ${attempt}/${GENERATE_MAX_RETRIES}) — retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error(`Generate failed (attempt ${attempt}/${GENERATE_MAX_RETRIES}):`, err);
          await sendAlert(
            `Pipeline failed after ${attempt} attempt(s).\n\n` +
            `Error: ${err?.message ?? String(err)}\n\n` +
            `Run \`npm run generate\` manually to retry.`
          );
          return 'started';
        }
      }
    }
  } finally {
    isGenerating = false;
  }
  return 'started';
}

let isPublishing = false;

async function publishDuePosts() {
  if (isPublishing || alreadyPostedToday()) {
    return;
  }

  const due = getPostsDueForPublishing();
  if (due.length === 0) return;

  isPublishing = true;
  try {
  for (const post of due) {
    console.log(`Publishing post ${post.id} — "${post.draft.sourceTitle}"`);
    try {
      // Resolve which image to use based on approval choice
      const imageOpts: Record<string, string | undefined> = {};
      if (post.imageChoice === 'ai' && post.draft.generatedImagePath) {
        imageOpts.generatedImagePath = post.draft.generatedImagePath;
      } else if (post.imageChoice === 'og' && post.draft.imageUrl) {
        imageOpts.imageUrl = post.draft.imageUrl;
      } else if (!post.imageChoice && post.draft.imageUrl) {
        // Legacy fallback: no imageChoice set, use og:image (backward compat)
        imageOpts.imageUrl = post.draft.imageUrl;
      }
      // imageChoice === 'none' → no image properties set

      const linkedInPostUrl = await postToLinkedIn(post.finalContent, {
        firstComment: post.draft.firstComment,
        ...imageOpts,
      });
      markPublished(post.id, linkedInPostUrl);
      console.log(`Post ${post.id} marked as published.`);
      const urlLine = linkedInPostUrl ? `\n${linkedInPostUrl}` : '';
      await sendMessage(`✅ *Published* | ${post.draft.postType}\n_${post.draft.sourceTitle}_${urlLine}`).catch(() => {});
    } catch (err) {
      if (err instanceof LinkedInSessionExpiredError) {
        console.error(err.message);
        break;
      }
      console.error(`Failed to publish post ${post.id}:`, err);
      const failures = incrementPublishFailures(post.id);
      if (failures >= 3) {
        await sendAlert(
          `Post "${post.draft.sourceTitle}" has failed to publish ${failures} times in a row.\n\n` +
          `Error: ${(err as any)?.message ?? String(err)}\n\n` +
          `Run \`npm run post-now\` to retry manually.`
        );
      }
    }
  }
  } finally {
    isPublishing = false;
  }
}

console.log('Atomic Authority scheduler starting...');
startBot();
setOnRejectHandler(runGenerate);
setOnGenerateHandler(runGenerate);
setOnPollHandler(() => runCommentPollGuarded());
setOnOutboundHandler(async () => {
  if (outboundPollRunning) throw new Error('Outbound poll already running — try again shortly.');
  outboundPollRunning = true;
  try {
    await runOutboundPoll();
  } catch (err) {
    console.error('Outbound poll failed:', err);
    throw err;
  } finally {
    outboundPollRunning = false;
  }
});

setOnMetricsHandler(async () => {
  console.log('[/metrics] Running metrics fetch...');
  await runMetricsFetch();
  console.log('[/metrics] Sending performance report...');
  await runWeeklyReport();
  console.log('[/metrics] Metrics fetch and report complete.');
});

setOnRewriteHandler(async (postId: string) => {
  const posts = getPostsDueForPublishing();
  const pending = getPendingPosts();
  const post = [...pending, ...posts].find(p => p.id === postId);
  if (!post) throw new Error(`Post ${postId} not found.`);
  console.log(`[rewrite] Rewriting post ${postId}...`);
  await rewritePost(post);
  console.log(`[rewrite] Rewrite complete.`);
});

// Generate a draft at 7pm Mon/Tue/Wed ET — approve that evening, posts next morning (Tue/Wed/Thu)
cron.schedule('0 19 * * 1,2,3', async () => {
  await runGenerate();
}, { timezone: 'America/Toronto' });

// Poll every minute for posts due to be published
cron.schedule('* * * * *', async () => {
  await publishDuePosts();
}, { timezone: 'America/Toronto' });

// Daily maintenance at 8am ET: session check, metrics fetch, rejected post cleanup
cron.schedule('0 8 * * *', async () => {
  console.log('[maintenance] Starting daily maintenance...');

  console.log('[maintenance] Cleaning up rejected posts older than 90 days...');
  try {
    cleanupRejectedPosts(90);
    console.log('[maintenance] Rejected post cleanup complete.');
  } catch (err) {
    console.error('[maintenance] Rejected post cleanup failed:', err);
  }

  console.log('[maintenance] Checking LinkedIn session...');
  let sessionValid = false;
  try {
    sessionValid = await pingSession();
  } catch (err) {
    console.error('[maintenance] Session check failed:', err);
  }

  if (!sessionValid) {
    console.warn('[maintenance] LinkedIn session expired — sending Telegram alert.');
    await sendAlert(
      'LinkedIn session has expired and needs to be renewed.\n\n' +
      'Send /login to this bot to open the browser directly, or run:\n' +
      '`LINKEDIN_HEADLESS=false npm run scheduler`'
    );
  } else {
    console.log('[maintenance] LinkedIn session OK.');

    console.log('[maintenance] Fetching engagement metrics...');
    try {
      await runMetricsFetch();
      console.log('[maintenance] Metrics fetch complete.');
    } catch (err) {
      console.error('[maintenance] Metrics fetch failed (non-fatal):', err);
    }

    // Send weekly report on Mondays
    if (new Date().getDay() === 1) {
      console.log('[maintenance] Sending weekly report...');
      try {
        await runWeeklyReport();
        console.log('[maintenance] Weekly report sent.');
      } catch (err) {
        console.error('[maintenance] Weekly report failed (non-fatal):', err);
      }
    }
  }

  console.log('[maintenance] Daily maintenance complete.');
}, { timezone: 'America/Toronto' });

// --- Comment reply polling ---

function getMostRecentPostAge(): number | null {
  if (!existsSync('posted_history.json')) return null;
  try {
    const history: any[] = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    const published = history
      .filter(p => p.status === 'published' && p.publishedAt)
      .map(p => new Date(p.publishedAt).getTime())
      .filter(t => !isNaN(t));
    if (published.length === 0) return null;
    return Date.now() - Math.max(...published);
  } catch {
    return null;
  }
}

let commentPollRunning = false;

async function runCommentPollGuarded(opts?: CommentPollOptions): Promise<CommentPollStats> {
  if (commentPollRunning) return { postsChecked: 0, totalComments: 0, newComments: 0, error: 'already running' };
  commentPollRunning = true;
  try {
    return await runCommentPoll(undefined, opts);
  } catch (err: any) {
    console.error('Comment poll failed:', err);
    return { postsChecked: 0, totalComments: 0, newComments: 0, error: err?.message ?? String(err) };
  } finally {
    commentPollRunning = false;
  }
}

// Weekdays: every 10 minutes — run immediately if a post is <2h old,
// otherwise only if 3+ hours have passed since the last poll.
cron.schedule('*/10 * * * 1-5', async () => {
  const ageMs = getMostRecentPostAge();
  const withinActiveWindow = ageMs !== null && ageMs < 2 * 60 * 60 * 1000;
  const lastPoll = getLastPollAt();
  const hoursSincePoll = lastPoll ? (Date.now() - lastPoll.getTime()) / 3_600_000 : Infinity;

  if (withinActiveWindow) {
    // Active window: only check the most recent post
    await runCommentPollGuarded({ recentOnly: true });
  } else if (hoursSincePoll >= 3) {
    // Quiet period: full sweep of all posts in the 14-day window
    await runCommentPollGuarded();
  }
}, { timezone: 'America/Toronto' });

// Weekends: 8am and 8pm ET only — full sweep
cron.schedule('0 8,20 * * 6,0', async () => {
  await runCommentPollGuarded();
}, { timezone: 'America/Toronto' });

// --- Outbound engagement polling ---

let outboundPollRunning = false;

// Weekdays at 10am and 2pm ET — finds fresh posts on curated profiles and queues comment options
cron.schedule('0 10,14 * * 1-5', async () => {
  if (outboundPollRunning) return;
  outboundPollRunning = true;
  try {
    await runOutboundPoll();
  } catch (err) {
    console.error('Outbound poll failed (non-fatal):', err);
  } finally {
    outboundPollRunning = false;
  }
}, { timezone: 'America/Toronto' });
