import crypto from 'crypto';
import { openScrapeContext, scrapeProfilePostsWithPage, type ScrapedPost } from '../outbound/scrape-feed.js';
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
  storeFallbackCandidate,
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

  // Collect all fresh unseen posts across every profile — one browser context for all scrapes
  const candidates: Array<ScrapedPost & { profile: OutboundProfile }> = [];

  const { context, page } = await openScrapeContext();
  try {
  for (const profile of profiles) {
    let posts;
    try {
      posts = await scrapeProfilePostsWithPage(profile.url, page);
    } catch (err) {
      console.warn(`  Failed to scrape ${profile.name}: ${(err as Error).message}`);
      continue;
    }

    // Determine the profile owner's display name — use first post's authorName if profile
    // name still looks like a URL slug (no spaces), then persist it for future runs.
    const ownerName = (posts.length > 0 && posts[0].authorName)
      ? posts[0].authorName
      : profile.name;
    if (ownerName && ownerName !== profile.name) {
      updateProfileName(profile.url, ownerName);
    }

    // Filter out reposts: on a profile page, any post whose author doesn't match
    // the profile owner is a reshare of someone else's content.
    const ownPosts = posts.filter(p =>
      !p.authorName || p.authorName.toLowerCase() === ownerName.toLowerCase()
    );
    const repostCount = posts.length - ownPosts.length;
    if (repostCount > 0) console.log(`  ${ownerName} — skipped ${repostCount} repost(s)`);

    const newPosts = ownPosts.filter(p => !isPostSeen(p.id));
    const ageNote = newPosts.map(p => p.ageHours !== null ? `${p.ageHours.toFixed(1)}h` : '?h').join(', ');
    console.log(`  ${ownerName} — ${ownPosts.length} original post(s) < 12h, ${newPosts.length} new${newPosts.length ? ` (${ageNote})` : ''}`);

    candidates.push(...newPosts.map(p => ({ ...p, profile })));
  }
  } finally {
    await context.close();
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

  // Store the 2nd candidate as a skip fallback (cleared after it's used or a new poll runs)
  const fallback = candidates[1] ?? null;
  storeFallbackCandidate(fallback ? {
    id: fallback.id,
    url: fallback.url,
    text: fallback.text,
    authorName: fallback.authorName,
    ageHours: fallback.ageHours,
    profileUrl: fallback.profile.url,
    profileName: fallback.profile.name,
    insider: fallback.profile.insider ?? false,
    colleague: fallback.profile.colleague ?? false,
  } : null);

  markPostSeen(best.id);

  let generated;
  try {
    generated = await generateOutboundComment(best, { insider: best.profile.insider ?? false, colleague: best.profile.colleague ?? false });
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
    postSummary: generated.postSummary,
    postAgeHours: best.ageHours,
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
