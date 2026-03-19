import 'dotenv/config';
import cron from 'node-cron';
import { getPostsDueForPublishing, markPublished } from '../hitl/queue.js';
import { postToLinkedIn, pingSession, LinkedInSessionExpiredError } from '../poster/index.js';
import { startBot, sendAlert } from '../hitl/telegram.js';
import { runPipeline } from '../content/pipeline.js';

async function runGenerate() {
  console.log('Scheduler triggered — running pipeline...');
  try {
    await runPipeline();
  } catch (err) {
    console.error('Generate failed:', err);
  }
}

async function publishDuePosts() {
  const due = getPostsDueForPublishing();
  if (due.length === 0) return;

  for (const post of due) {
    console.log(`Publishing post ${post.id} — "${post.draft.sourceTitle}"`);
    try {
      await postToLinkedIn(post.finalContent);
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
