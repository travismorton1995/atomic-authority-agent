import { readFileSync, existsSync } from 'fs';
import { scrapeComments } from '../poster/comments.js';
import { generateReplies } from '../content/reply.js';
import {
  isCommentSeen,
  markCommentSeen,
  addPendingReply,
  recordPoll,
  PendingReply,
} from './comment-queue.js';
import { notifyCommentReply } from './telegram.js';

const HISTORY_FILE = 'posted_history.json';
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface CommentPollOptions {
  recentOnly?: boolean; // only check the most recently published post
}

export interface CommentPollStats {
  postsChecked: number;
  totalComments: number;
  newComments: number;
  error?: string;
}

export async function runCommentPoll(targetUrl?: string, opts: CommentPollOptions = {}): Promise<CommentPollStats> {
  if (!existsSync(HISTORY_FILE)) return;

  const myName = (process.env.LINKEDIN_DISPLAY_NAME ?? '').toLowerCase();
  if (!myName) console.warn('LINKEDIN_DISPLAY_NAME not set — own comments will not be filtered.');

  const history: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));

  let recentPosts: any[];

  if (targetUrl) {
    // Extract the 19-digit activity ID present in both URL formats:
    //   /posts/...-activity-7440740463885746176-PKeC/
    //   /feed/update/urn:li:activity:7440740463885746176/
    const activityIdMatch = targetUrl.match(/(\d{15,})/);
    const activityId = activityIdMatch?.[1];
    const match = activityId && history.find((p: any) =>
      p.linkedInPostUrl && p.linkedInPostUrl.includes(activityId)
    );
    if (!match) {
      console.log(`No post found in history for activity ID: ${activityId ?? targetUrl}`);
      console.log('Falling back to URL directly...');
      recentPosts = [{ linkedInPostUrl: targetUrl.split('?')[0], finalContent: '', draft: { postType: 'unknown' } }];
    } else {
      recentPosts = [match];
    }
  } else if (opts.recentOnly) {
    const published = history.filter(p => p.status === 'published' && p.linkedInPostUrl && p.publishedAt);
    published.sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    recentPosts = published.slice(0, 1);
  } else {
    const cutoff = Date.now() - WINDOW_MS;
    recentPosts = history.filter(
      p =>
        p.status === 'published' &&
        p.linkedInPostUrl &&
        p.publishedAt &&
        new Date(p.publishedAt).getTime() >= cutoff,
    );
  }

  if (recentPosts.length === 0) return { postsChecked: 0, totalComments: 0, newComments: 0 };

  const scope = opts.recentOnly ? 'most recent post' : 'last 14 days';
  console.log(`Comment poll: checking ${recentPosts.length} post(s) (${scope})...`);

  let totalComments = 0;
  let totalNew = 0;

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
      if (myName && c.author.toLowerCase().includes(myName)) return false;
      return true;
    });

    totalComments += comments.length;
    totalNew += newComments.length;
    console.log(`  ${post.draft?.postType} — ${comments.length} comment(s), ${newComments.length} new`);

    for (const comment of newComments) {
      // Mark seen immediately so a crash mid-loop doesn't re-notify
      markCommentSeen(comment.id);

      // Build thread context: other comments in the thread, excluding own
      const thread = comments
        .filter(c => c.id !== comment.id && !(myName && c.author.toLowerCase().includes(myName)))
        .map(c => ({ author: c.author, text: c.text }));

      let generated;
      try {
        generated = await generateReplies(
          {
            content: post.finalContent,
            postType: post.draft?.postType ?? 'unknown',
            articleTitle: post.draft?.sourceTitle,
          },
          { author: comment.author, text: comment.text },
          thread,
        );
        console.log(`  [${comment.author}] type=${generated.commentType} | ${generated.options.map(o => o.label).join(', ')}`);
        console.log(`  reasoning: ${generated.reasoning.slice(0, 120)}...`);
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
        commentType: generated.commentType,
        isReply: comment.isReply,
        replyOptions: [generated.options[0].text, generated.options[1].text, generated.options[2].text],
        replyLabels: [generated.options[0].label, generated.options[1].label, generated.options[2].label],
        recommendationReason: generated.recommendationReason,
        reasoning: generated.reasoning,
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
  return { postsChecked: recentPosts.length, totalComments, newComments: totalNew };
}
