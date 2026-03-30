import 'dotenv/config';
import cron from 'node-cron';
import { getPostsDueForPublishing, markPublished, incrementPublishFailures, cleanupRejectedPosts } from '../hitl/queue.js';
import { readFileSync, existsSync } from 'fs';

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
import { startBot, sendAlert, setOnRejectHandler } from '../hitl/telegram.js';
import { runPipeline } from '../content/pipeline.js';
import { runMetricsFetch, runWeeklyReport } from '../cli/fetch-metrics.js';

const GENERATE_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const GENERATE_NETWORK_RETRY_DELAY_MS = 60 * 1000; // 1 minute
const GENERATE_MAX_RETRIES = 3;

let isGenerating = false;

async function runGenerate() {
  if (isGenerating) {
    console.log('Pipeline already running — ignoring duplicate trigger.');
    return;
  }
  isGenerating = true;
  console.log('Scheduler triggered — running pipeline...');
  try {
    for (let attempt = 1; attempt <= GENERATE_MAX_RETRIES; attempt++) {
      try {
        await runPipeline();
        return;
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
          return;
        }
      }
    }
  } finally {
    isGenerating = false;
  }
}

async function publishDuePosts() {
  if (alreadyPostedToday()) {
    return;
  }

  const due = getPostsDueForPublishing();
  if (due.length === 0) return;

  for (const post of due) {
    console.log(`Publishing post ${post.id} — "${post.draft.sourceTitle}"`);
    try {
      const linkedInPostUrl = await postToLinkedIn(post.finalContent, {
        firstComment: post.draft.firstComment,
        imageUrl: post.draft.imageUrl,
      });
      markPublished(post.id, linkedInPostUrl);
      console.log(`Post ${post.id} marked as published.`);
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
}

console.log('Atomic Authority scheduler starting...');
startBot();
setOnRejectHandler(runGenerate);

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
  console.log('Running daily maintenance...');
  cleanupRejectedPosts(90);

  const valid = await pingSession();
  if (!valid) {
    console.warn('LinkedIn session expired — sending Telegram alert.');
    await sendAlert(
      'LinkedIn session has expired and needs to be renewed.\n\n' +
      'Run the following in your terminal to re-authenticate:\n' +
      '`LINKEDIN_HEADLESS=false npm run scheduler`'
    );
  } else {
    console.log('LinkedIn session OK.');
    console.log('Fetching engagement metrics...');
    await runMetricsFetch().catch(err => console.error('Metrics fetch failed (non-fatal):', err));

    // Send weekly report on Mondays
    if (new Date().getDay() === 1) {
      await runWeeklyReport().catch(err => console.error('Weekly report failed (non-fatal):', err));
    }

    console.log('Daily maintenance complete.');
  }
}, { timezone: 'America/Toronto' });
