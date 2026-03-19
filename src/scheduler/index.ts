import 'dotenv/config';
import cron from 'node-cron';
import { getPostsDueForPublishing, markPublished } from '../hitl/queue.js';
import { postToLinkedIn, LinkedInSessionExpiredError } from '../poster/index.js';
import { startBot } from '../hitl/telegram.js';
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

// Generate a draft every weekday at 8:30am ET
cron.schedule('30 8 * * 1-5', async () => {
  await runGenerate();
}, { timezone: 'America/Toronto' });

// Poll every minute for posts due to be published
cron.schedule('* * * * *', async () => {
  await publishDuePosts();
}, { timezone: 'America/Toronto' });
