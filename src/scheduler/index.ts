import 'dotenv/config';
import cron from 'node-cron';
import { getPostsDueForPublishing, markPublished } from '../hitl/queue.js';
import { postToLinkedIn, pingSession, LinkedInSessionExpiredError } from '../poster/index.js';
import { startBot, sendAlert, setOnRejectHandler } from '../hitl/telegram.js';
import { runPipeline } from '../content/pipeline.js';

const GENERATE_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const GENERATE_MAX_RETRIES = 3;

async function runGenerate() {
  console.log('Scheduler triggered — running pipeline...');
  for (let attempt = 1; attempt <= GENERATE_MAX_RETRIES; attempt++) {
    try {
      await runPipeline();
      return;
    } catch (err: any) {
      const isOverloaded = err?.status === 529 || err?.error?.error?.type === 'overloaded_error';
      if (isOverloaded && attempt < GENERATE_MAX_RETRIES) {
        console.warn(`Anthropic API overloaded (attempt ${attempt}/${GENERATE_MAX_RETRIES}) — retrying in 10 minutes...`);
        await new Promise(resolve => setTimeout(resolve, GENERATE_RETRY_DELAY_MS));
      } else {
        console.error(`Generate failed (attempt ${attempt}/${GENERATE_MAX_RETRIES}):`, err);
        await sendAlert(
          `Pipeline failed after ${GENERATE_MAX_RETRIES} attempts.\n\n` +
          `Error: ${err?.message ?? String(err)}\n\n` +
          `Run \`npm run generate\` manually to retry.`
        );
        return;
      }
    }
  }
}

async function publishDuePosts() {
  const due = getPostsDueForPublishing();
  if (due.length === 0) return;

  for (const post of due) {
    console.log(`Publishing post ${post.id} — "${post.draft.sourceTitle}"`);
    try {
      await postToLinkedIn(post.finalContent, { firstComment: post.draft.firstComment });
      markPublished(post.id);
      console.log(`Post ${post.id} marked as published.`);
    } catch (err) {
      if (err instanceof LinkedInSessionExpiredError) {
        console.error(err.message);
        break;
      }
      console.error(`Failed to publish post ${post.id}:`, err);
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

// Daily session ping at 8am ET — alerts via Telegram if login is required
cron.schedule('0 8 * * *', async () => {
  console.log('Running daily LinkedIn session check...');
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
  }
}, { timezone: 'America/Toronto' });
