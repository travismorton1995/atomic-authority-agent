import crypto from 'crypto';
import { openScrapeContext, scrapeProfilePostsWithPage, scrapeHashtagWithPage, type ScrapedPost } from '../outbound/scrape-feed.js';
import { generateOutboundComment } from '../outbound/generate-comment.js';
import { relevanceHits } from '../outbound/relevance.js';
import { isSessionExpiredUrl } from '../poster/index.js';
import {
  getActiveProfiles,
  isPostSeen,
  markPostSeen,
  addPendingComment,
  recordOutboundPoll,
  updateProfileName,
  recordProfilePollResult,
  storeFallbackCandidate,
  hoursSinceLastComment,
  type OutboundProfile,
  type PendingComment,
} from '../outbound/outbound-queue.js';
import { notifyOutboundComment } from './telegram.js';

// Hashtags to monitor for commenting opportunities — scraped alongside curated profiles
// DISABLED: LinkedIn search results use anti-scraping measures that prevent reliable extraction.
// Re-enable when a workaround is found (e.g. LinkedIn API, RSS, or updated selectors).
const HASHTAGS: string[] = [
  // 'NuclearEnergy',
  // 'SMR',
  // 'AdvancedReactors',
  // 'NuclearSafety',
  // 'NuclearIndustry',
  // 'AIinEnergy',
  // 'EnergyTransition',
  // 'CleanEnergy',
  // 'AIGovernance',
  // 'NuclearPower',
  // 'Decarbonization',
  // 'DigitalTwin',
  // 'CriticalInfrastructure',
  // 'NuclearInnovation',
];

// Profile bias: profile candidates get a small score bonus over hashtag candidates
const PROFILE_BONUS = 0.1;

type CandidateSource = 'profile' | 'hashtag';

interface Candidate extends ScrapedPost {
  profile: OutboundProfile | null; // null for hashtag-sourced posts
  source: CandidateSource;
  sourceLabel: string;             // profile name or #hashtag
}

export async function runOutboundPoll(): Promise<void> {
  const profiles = getActiveProfiles();
  if (profiles.length === 0 && HASHTAGS.length === 0) {
    console.log('Outbound poll: no active profiles or hashtags configured.');
    return;
  }

  console.log(`Outbound poll: checking ${profiles.length} profile(s) + ${HASHTAGS.length} hashtag(s)...`);

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>(); // deduplicate across profiles and hashtags

  // Reduce polling frequency for profiles that haven't posted recently.
  // - No lastSeenPostAt or seen within 2 days → check every time
  // - Dry for 2–5 days → check every other poll (staggered by profile ID)
  // - Dry for 5+ days → check every 4th poll (staggered by profile ID)
  // Resets to every-time as soon as a new post is found (via recordProfilePollResult).
  let skippedDry = 0;
  const now = Date.now();
  const pollProfiles = profiles.filter(profile => {
    const lastSeen = profile.lastSeenPostAt ? new Date(profile.lastSeenPostAt).getTime() : 0;
    const daysDry = lastSeen === 0 ? 0 : (now - lastSeen) / (1000 * 60 * 60 * 24);

    if (daysDry < 2) return true;

    const checkEvery = daysDry < 5 ? 2 : 4;
    const pollCount = profile.consecutiveDryPolls ?? 0;
    const offset = profile.id.charCodeAt(0) % checkEvery;
    const shouldCheck = (pollCount + offset) % checkEvery === 0;
    if (!shouldCheck) skippedDry++;
    return shouldCheck;
  });
  if (skippedDry > 0) console.log(`  Skipping ${skippedDry} profile(s) — no recent posts (checked less frequently).`);

  const { context, page } = await openScrapeContext();
  try {
    // Verify LinkedIn session before scraping
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (isSessionExpiredUrl(page.url())) {
      console.error('Outbound poll: LinkedIn session expired. Run /login to renew.');
      recordOutboundPoll();
      return;
    }

    // --- Scrape curated profiles ---
    for (const profile of pollProfiles) {
      let posts;
      try {
        posts = await scrapeProfilePostsWithPage(profile.url, page);
      } catch (err) {
        console.warn(`  Failed to scrape ${profile.name}: ${(err as Error).message}`);
        continue;
      }

      const ownerName = (posts.length > 0 && posts[0].authorName)
        ? posts[0].authorName
        : profile.name;
      if (ownerName && ownerName !== profile.name) {
        updateProfileName(profile.url, ownerName);
      }

      // Filter out reposts
      const ownPosts = posts.filter(p =>
        !p.authorName || p.authorName.toLowerCase() === ownerName.toLowerCase()
      );
      const repostCount = posts.length - ownPosts.length;
      if (repostCount > 0) console.log(`  ${ownerName} — skipped ${repostCount} repost(s)`);

      const newPosts = ownPosts.filter(p => !isPostSeen(p.id));
      const ageNote = newPosts.map(p => p.ageHours !== null ? `${p.ageHours.toFixed(1)}h` : '?h').join(', ');
      console.log(`  ${ownerName} — ${ownPosts.length} original post(s) < 12h, ${newPosts.length} new${newPosts.length ? ` (${ageNote})` : ''}`);

      recordProfilePollResult(profile.url, newPosts.length > 0);
      for (const p of newPosts) {
        seenIds.add(p.id);
        candidates.push({ ...p, profile, source: 'profile', sourceLabel: ownerName });
      }
    }

    // --- Scrape hashtag feeds ---
    for (const tag of HASHTAGS) {
      let posts;
      try {
        posts = await scrapeHashtagWithPage(tag, page);
      } catch (err) {
        console.warn(`  Failed to scrape #${tag}: ${(err as Error).message}`);
        continue;
      }

      // Deduplicate: skip posts already found via profiles or earlier hashtags
      const newPosts = posts.filter(p => !seenIds.has(p.id) && !isPostSeen(p.id));
      console.log(`  #${tag} — ${posts.length} post(s), ${newPosts.length} new`);

      for (const p of newPosts) {
        seenIds.add(p.id);
        candidates.push({ ...p, profile: null, source: 'hashtag', sourceLabel: `#${tag}` });
      }
    }
  } finally {
    await context.close();
  }

  if (candidates.length === 0) {
    console.log('No new posts found. Nothing queued.');
    recordOutboundPoll();
    return;
  }

  // Score each candidate: higher score = better pick
  // Four factors: relevance, recency, profile diversity, and source bonus
  const scored = candidates.map(c => {
    const postAge = c.ageHours ?? 12;
    const profileCooldown = c.source === 'profile'
      ? hoursSinceLastComment(c.profile!.url)
      : Infinity; // hashtag posts from strangers — no cooldown penalty
    const keywords = relevanceHits(c.text);

    // Relevance: 0–1 (0 = no keywords, 1 = 5+ keyword hits)
    const relevanceScore = Math.min(keywords / 5, 1);

    // Recency: 0–1 (1 = brand new, 0 = 12h old)
    const recencyScore = 1 - Math.min(postAge / 12, 1);

    // Diversity: 0–1 (1 = never commented or 48h+ ago, 0 = just commented)
    const diversityScore = profileCooldown >= 48 ? 1 : profileCooldown / 48;

    // Weighted: 50% relevance, 30% recency, 20% diversity + profile bonus
    let score = relevanceScore * 0.5 + recencyScore * 0.3 + diversityScore * 0.2;
    if (c.source === 'profile') score += PROFILE_BONUS;

    return { candidate: c, score, postAge, profileCooldown, keywords };
  });

  // Hard-filter only hashtag candidates with zero relevance (strangers posting off-topic).
  // Profile candidates always pass — you curated them for a reason. Keywords boost their
  // score but don't exclude them.
  const eligible = scored.filter(s => s.candidate.source === 'profile' || s.keywords > 0);
  if (eligible.length === 0) {
    console.log(`  ${scored.length} candidate(s) found but none were eligible. Nothing queued.`);
    recordOutboundPoll();
    return;
  }

  eligible.sort((a, b) => b.score - a.score);

  const pick = eligible[0];
  const best = pick.candidate;
  const ageLabel = best.ageHours !== null ? `${best.ageHours.toFixed(1)}h old` : 'unknown age';
  const inGoldenWindow = best.ageHours !== null && best.ageHours < 2;
  const cooldownLabel = pick.profileCooldown === Infinity ? 'never' : `${pick.profileCooldown.toFixed(0)}h ago`;
  const sourceTag = best.source === 'profile' ? 'profile' : best.sourceLabel;
  console.log(`  Picked: [${best.authorName || best.sourceLabel}] ${ageLabel}${inGoldenWindow ? ' ⚡ golden window' : ''} | ${pick.keywords} keyword(s) | ${sourceTag} | last comment: ${cooldownLabel}`);

  // Store the 2nd candidate as a skip fallback
  const fb = eligible[1]?.candidate ?? null;
  storeFallbackCandidate(fb ? {
    id: fb.id,
    url: fb.url,
    text: fb.text,
    authorName: fb.authorName,
    ageHours: fb.ageHours,
    profileUrl: fb.profile?.url ?? '',
    profileName: fb.profile?.name ?? fb.authorName,
    insider: fb.profile?.insider ?? false,
    colleague: fb.profile?.colleague ?? false,
  } : null);

  markPostSeen(best.id);

  // Hashtag posts are from strangers — avoid counterpoint, lean toward ask-question / add-context
  const isStranger = best.source === 'hashtag';
  let generated;
  try {
    generated = await generateOutboundComment(
      { text: best.text, authorName: best.authorName, url: best.url },
      {
        insider: best.profile?.insider ?? false,
        colleague: best.profile?.colleague ?? false,
        stranger: isStranger,
      },
    );
    console.log(`  Options: ${generated.options.map(o => o.label).join(', ')}`);
  } catch (err) {
    console.warn(`  Failed to generate comment: ${(err as Error).message}`);
    recordOutboundPoll();
    return;
  }

  const comment: PendingComment = {
    id: `oc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    profileUrl: best.profile?.url ?? '',
    profileName: best.profile?.name ?? best.authorName,
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
