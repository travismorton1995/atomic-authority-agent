import 'dotenv/config';
import { getPendingPosts, rejectPost } from '../hitl/queue.js';

const args = process.argv.slice(2);
const idFlagIndex = args.indexOf('--id');
const id = idFlagIndex !== -1 ? args[idFlagIndex + 1] : null;

const pending = getPendingPosts();

if (pending.length === 0) {
  console.log('No pending posts.');
  process.exit(0);
}

if (!id) {
  console.log('Pending posts:\n');
  for (const post of pending) {
    console.log(`ID: ${post.id} | Type: ${post.draft.postType}`);
  }
  console.log(`\nRun: npm run reject -- --id <id>`);
  process.exit(0);
}

const post = rejectPost(id);
if (!post) {
  console.error(`No pending post found with ID: ${id}`);
  process.exit(1);
}

console.log(`Post ${id} rejected.`);
