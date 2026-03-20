import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { markPublished, PendingPost } from '../hitl/queue.js';
import { postToLinkedIn, LinkedInSessionExpiredError } from '../poster/index.js';

// Finds all approved posts regardless of scheduledFor time
function getApprovedPosts(): PendingPost[] {
  if (!existsSync('pending_posts.json')) return [];
  try {
    const posts = JSON.parse(readFileSync('pending_posts.json', 'utf-8')) as PendingPost[];
    return posts.filter(p => p.status === 'approved');
  } catch {
    return [];
  }
}

async function main() {
  const approved = getApprovedPosts();

  if (approved.length === 0) {
    console.log('No approved posts found.');
    process.exit(0);
  }

  // Pick the oldest approved post
  const post = approved.sort((a, b) =>
    new Date(a.actedAt ?? a.createdAt).getTime() - new Date(b.actedAt ?? b.createdAt).getTime()
  )[0];

  console.log(`Publishing post ${post.id}`);
  console.log(`Type: ${post.draft.postType} | Source: ${post.draft.sourceTitle}`);
  console.log(`\n${post.finalContent}\n`);
  console.log('Opening browser...\n');

  try {
    await postToLinkedIn(post.finalContent, {
      forceHeaded: true,
      firstComment: post.draft.firstComment,
      imageUrl: post.draft.imageUrl,
    });
    markPublished(post.id);
    console.log(`Done. Post ${post.id} marked as published.`);
  } catch (err) {
    if (err instanceof LinkedInSessionExpiredError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
