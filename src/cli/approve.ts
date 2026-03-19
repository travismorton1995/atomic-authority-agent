import 'dotenv/config';
import { getPendingPosts, approvePost } from '../hitl/queue.js';
import { pickScheduledTime } from '../scheduler/windows.js';

const args = process.argv.slice(2);
const idFlagIndex = args.indexOf('--id');
const id = idFlagIndex !== -1 ? args[idFlagIndex + 1] : null;

const pending = getPendingPosts();

if (pending.length === 0) {
  console.log('No pending posts.');
  process.exit(0);
}

if (!id) {
  // Show pending list if no ID given
  console.log('Pending posts:\n');
  for (const post of pending) {
    console.log(`ID: ${post.id}`);
    console.log(`Type: ${post.draft.postType} | Source: ${post.draft.sourceTitle}`);
    console.log(`Cringe: ${post.screening.cringeScore}/10`);
    console.log('---');
    console.log(post.finalContent);
    console.log('---\n');
  }
  console.log(`Run: npm run approve -- --id <id>`);
  process.exit(0);
}

const scheduledFor = pickScheduledTime();
const post = approvePost(id, scheduledFor);
if (!post) {
  console.error(`No pending post found with ID: ${id}`);
  process.exit(1);
}

const scheduled = new Date(scheduledFor).toLocaleString('en-US', {
  timeZone: 'America/Toronto',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
console.log(`Post ${id} approved.`);
console.log(`Scheduled to post: ${scheduled}`);
console.log('Keep the scheduler running — it will publish automatically.');
