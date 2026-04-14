import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { markPublished, PendingPost } from '../hitl/queue.js';
import { postToLinkedIn, LinkedInSessionExpiredError } from '../poster/index.js';
import { sendMessage } from '../hitl/telegram.js';

function getAllPosts(): PendingPost[] {
  if (!existsSync('pending_posts.json')) return [];
  try {
    return JSON.parse(readFileSync('pending_posts.json', 'utf-8')) as PendingPost[];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const postIdArg = args.find(a => a.startsWith('--post_id='))?.split('=')[1];

  const all = getAllPosts();

  let post: PendingPost | undefined;

  if (postIdArg) {
    post = all.find(p => p.id === postIdArg);
    if (!post) {
      console.error(`No post found with ID: ${postIdArg}`);
      process.exit(1);
    }
    if (post.status !== 'approved' && post.status !== 'pending') {
      console.error(`Post ${postIdArg} has status "${post.status}" — only pending or approved posts can be posted.`);
      process.exit(1);
    }
  } else {
    const approved = all.filter(p => p.status === 'approved');
    if (approved.length === 0) {
      console.log('No approved posts found. Pass --post_id=<id> to post a specific pending post.');
      process.exit(0);
    }
    // Pick the oldest approved post
    post = approved.sort((a, b) =>
      new Date(a.actedAt ?? a.createdAt).getTime() - new Date(b.actedAt ?? b.createdAt).getTime()
    )[0];
  }

  console.log(`Publishing post ${post.id}`);
  console.log(`Type: ${post.draft.postType} | Source: ${post.draft.sourceTitle}`);
  console.log(`\n${post.finalContent}\n`);
  console.log('Opening browser...\n');

  try {
    // Resolve which image to use based on approval choice
    const imageOpts: Record<string, string | undefined> = {};
    if ((post.imageChoice === 'ai' || post.imageChoice === 'custom') && post.draft.generatedImagePath) {
      imageOpts.generatedImagePath = post.draft.generatedImagePath;
    } else if (post.imageChoice === 'og' && post.draft.imageUrl) {
      imageOpts.imageUrl = post.draft.imageUrl;
    } else if (!post.imageChoice && post.draft.imageUrl) {
      imageOpts.imageUrl = post.draft.imageUrl;
    }

    const linkedInPostUrl = await postToLinkedIn(post.finalContent, {
      forceHeaded: true,
      firstComment: post.draft.firstComment,
      ...imageOpts,
    });
    markPublished(post.id, linkedInPostUrl);
    console.log(`Done. Post ${post.id} marked as published.`);
    const urlLine = linkedInPostUrl ? `\n${linkedInPostUrl}` : '';
    await sendMessage(`✅ *Published* | ${post.draft.postType}\n_${post.draft.sourceTitle}_${urlLine}`).catch(() => {});
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
