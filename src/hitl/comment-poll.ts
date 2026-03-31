import { readFileSync, existsSync } from 'fs';
import { scrapeComments } from '../poster/comments.js';
import { generateReplies, classifyComment } from '../content/reply.js';
import {
  isCommentSeen,
  markCommentSeen,
  addPendingReply,
  recordPoll,
  PendingReply,
} from './comment-queue.js';
import { notifyCommentReply } from './telegram.js';

const HISTORY_FILE = 'posted_history.json';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MY_NAME = (process.env.LINKEDIN_DISPLAY_NAME ?? '').toLowerCase();

export async function runCommentPoll(): Promise<void> {
  if (!existsSync(HISTORY_FILE)) return;

  const history: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  const cutoff = Date.now() - WEEK_MS;

  const recentPosts = history.filter(
    p =>
      p.status === 'published' &&
      p.linkedInPostUrl &&
      p.publishedAt &&
      new Date(p.publishedAt).getTime() >= cutoff,
  );

  if (recentPosts.length === 0) return;

  console.log(`Comment poll: checking ${recentPosts.length} post(s) from the last 7 days...`);

  for (const post of recentPosts) {
    let comments;
    try {
      comments = await scrapeComments(post.linkedInPostUrl);
    } catch (err) {
      console.warn(`  Failed to scrape ${post.linkedInPostUrl}: ${(err as Error).message}`);
      continue;
    }

    const newComments = comments.filter(c => {
      if (isCommentSeen(c.id)) return false;
      // Skip own comments
      if (MY_NAME && c.author.toLowerCase().includes(MY_NAME)) return false;
      return true;
    });

    console.log(`  ${post.draft?.postType} — ${comments.length} comment(s), ${newComments.length} new`);

    for (const comment of newComments) {
      // Mark seen immediately so a crash mid-loop doesn't re-notify
      markCommentSeen(comment.id);

      let options: [string, string, string];
      try {
        options = await generateReplies(
          { content: post.finalContent, postType: post.draft?.postType ?? 'unknown' },
          { author: comment.author, text: comment.text },
        );
      } catch (err) {
        console.warn(`  Failed to generate replies for comment by ${comment.author}: ${(err as Error).message}`);
        continue;
      }

      const reply: PendingReply = {
        id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        postUrl: post.linkedInPostUrl,
        postType: post.draft?.postType ?? 'unknown',
        postSnippet: post.finalContent?.split('\n')[0]?.slice(0, 80) ?? '',
        commentId: comment.id,
        commentAuthor: comment.author,
        commentText: comment.text,
        commentType: classifyComment(comment.text),
        isReply: comment.isReply,
        replyOptions: options,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      addPendingReply(reply);

      try {
        await notifyCommentReply(reply);
      } catch (err) {
        console.warn(`  Failed to send Telegram notification: ${(err as Error).message}`);
      }
    }
  }

  recordPoll();
  console.log('Comment poll complete.');
}
