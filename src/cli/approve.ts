import 'dotenv/config';
import { getPendingPosts, approvePost, setImageChoice } from '../hitl/queue.js';
import { pickScheduledTime, pickInsiderScheduledTime } from '../scheduler/windows.js';

const args = process.argv.slice(2);
const idFlagIndex = args.indexOf('--id');
const id = idFlagIndex !== -1 ? args[idFlagIndex + 1] : null;
const imageFlagIndex = args.indexOf('--image');
const imageChoice = imageFlagIndex !== -1 ? args[imageFlagIndex + 1] as 'ai' | 'og' | 'none' | 'custom' | 'stock' : undefined;

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
  console.log(`Run: npm run approve -- --id <id> [--image ai|og|none|custom]`);
  process.exit(0);
}

if (imageChoice) {
  if (!['ai', 'og', 'none', 'custom'].includes(imageChoice)) {
    console.error('Invalid --image value. Use: ai, og, none, or custom');
    process.exit(1);
  }
  setImageChoice(id, imageChoice);
}

// Check if this is an insider post — schedule for Sunday 7-8pm ET
const pendingPost = pending.find(p => p.id === id);
const isInsider = pendingPost?.draft.postType === 'insider';
const scheduledFor = isInsider ? pickInsiderScheduledTime() : pickScheduledTime();
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
