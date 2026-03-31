import crypto from 'crypto';
import { scrapeProfilePosts } from '../outbound/scrape-feed.js';
import { generateOutboundComment } from '../outbound/generate-comment.js';
import {
  getActiveProfiles,
  isPostSeen,
  markPostSeen,
  addPendingComment,
  getDailyCount,
  incrementDailyCount,
  recordOutboundPoll,
  updateProfileName,
  type PendingComment,
} from '../outbound/outbound-queue.js';
import { notifyOutboundComment } from './telegram.js';

const DAILY_MAX = 3;

export async function runOutboundPoll(): Promise<void> {
  const profiles = getActiveProfiles();
  if (profiles.length === 0) {
    console.log('Outbound poll: no active profiles. Add some by sending a LinkedIn URL to the Telegram bot.');
    return;
  }

  const remaining = DAILY_MAX - getDailyCount();
  if (remaining <= 0) {
    console.log(`Outbound poll: daily limit reached (${DAILY_MAX}/day).`);
    return;
  }

  console.log(`Outbound poll: ${profiles.length} profile(s), ${remaining} slot(s) remaining today...`);

  let queued = 0;

  for (const profile of profiles) {
    if (queued >= remaining) break;

    let posts;
    try {
      posts = await scrapeProfilePosts(profile.url);
    } catch (err) {
      console.warn(`  Failed to scrape ${profile.name || profile.url}: ${(err as Error).message}`);
      continue;
    }

    // Update stored name if we got a real one from the scrape
    if (posts.length > 0 && posts[0].authorName && posts[0].authorName !== profile.name) {
      updateProfileName(profile.url, posts[0].authorName);
    }

    const newPosts = posts.filter(p => !isPostSeen(p.id));
    console.log(`  ${profile.name} — ${posts.length} post(s) in last 48h, ${newPosts.length} new`);

    for (const post of newPosts) {
      if (queued >= remaining) break;

      markPostSeen(post.id);

      let generated;
      try {
        generated = await generateOutboundComment(post, { insider: profile.insider ?? false });
        console.log(`  [${post.authorName}] ${generated.options.map(o => o.label).join(', ')}`);
      } catch (err) {
        console.warn(`  Failed to generate comment for ${post.url}: ${(err as Error).message}`);
        continue;
      }

      const comment: PendingComment = {
        id: `oc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        profileUrl: profile.url,
        profileName: profile.name,
        postUrl: post.url,
        postSnippet: post.text.split('\n')[0].slice(0, 100),
        commentOptions: [generated.options[0].text, generated.options[1].text],
        commentLabels: [generated.options[0].label, generated.options[1].label],
        recommendationReason: generated.recommendationReason,
        reasoning: generated.reasoning,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      addPendingComment(comment);
      incrementDailyCount();
      queued++;

      try {
        await notifyOutboundComment(comment);
      } catch (err) {
        console.warn(`  Failed to send Telegram notification: ${(err as Error).message}`);
      }
    }
  }

  recordOutboundPoll();
  console.log(`Outbound poll complete. ${queued} comment(s) queued.`);
}
