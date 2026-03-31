import crypto from 'crypto';
import { scrapeProfilePosts, type ScrapedPost } from '../outbound/scrape-feed.js';
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
  type OutboundProfile,
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

  if (getDailyCount() >= DAILY_MAX) {
    console.log(`Outbound poll: daily limit reached (${DAILY_MAX}/day).`);
    return;
  }

  console.log(`Outbound poll: checking ${profiles.length} profile(s) for posts < 12h old...`);

  // Collect all fresh unseen posts across every profile
  const candidates: Array<ScrapedPost & { profile: OutboundProfile }> = [];

  for (const profile of profiles) {
    let posts;
    try {
      posts = await scrapeProfilePosts(profile.url);
    } catch (err) {
      console.warn(`  Failed to scrape ${profile.name}: ${(err as Error).message}`);
      continue;
    }

    if (posts.length > 0 && posts[0].authorName && posts[0].authorName !== profile.name) {
      updateProfileName(profile.url, posts[0].authorName);
    }

    const newPosts = posts.filter(p => !isPostSeen(p.id));
    const ageNote = newPosts.map(p => p.ageHours !== null ? `${p.ageHours.toFixed(1)}h` : '?h').join(', ');
    console.log(`  ${profile.name} — ${posts.length} post(s) < 12h, ${newPosts.length} new${newPosts.length ? ` (${ageNote})` : ''}`);

    candidates.push(...newPosts.map(p => ({ ...p, profile })));
  }

  if (candidates.length === 0) {
    console.log('No new posts found. Nothing queued.');
    recordOutboundPoll();
    return;
  }

  // Sort by recency: posts < 2h (golden window) first, then older posts, unknown age last
  candidates.sort((a, b) => {
    const ah = a.ageHours ?? Infinity;
    const bh = b.ageHours ?? Infinity;
    return ah - bh;
  });

  const best = candidates[0];
  const ageLabel = best.ageHours !== null ? `${best.ageHours.toFixed(1)}h old` : 'unknown age';
  const inGoldenWindow = best.ageHours !== null && best.ageHours < 2;
  console.log(`  Picked: [${best.profile.name}] ${ageLabel}${inGoldenWindow ? ' ⚡ golden window' : ''}`);

  markPostSeen(best.id);

  let generated;
  try {
    generated = await generateOutboundComment(best, { insider: best.profile.insider ?? false });
    console.log(`  Options: ${generated.options.map(o => o.label).join(', ')}`);
  } catch (err) {
    console.warn(`  Failed to generate comment: ${(err as Error).message}`);
    recordOutboundPoll();
    return;
  }

  const comment: PendingComment = {
    id: `oc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    profileUrl: best.profile.url,
    profileName: best.profile.name,
    postUrl: best.url,
    postSnippet: best.text.split('\n')[0].slice(0, 100),
    commentOptions: [generated.options[0].text, generated.options[1].text],
    commentLabels: [generated.options[0].label, generated.options[1].label],
    recommendationReason: generated.recommendationReason,
    reasoning: generated.reasoning,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  addPendingComment(comment);

  try {
    await notifyOutboundComment(comment);
  } catch (err) {
    console.warn(`  Failed to send Telegram notification: ${(err as Error).message}`);
  }

  recordOutboundPoll();
  console.log('Outbound poll complete. 1 comment queued.');
}
