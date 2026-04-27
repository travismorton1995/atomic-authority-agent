import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { openScrapeContext, scrapeProfilePostsWithPage, scrapeHashtagWithPage, type ScrapedPost } from '../outbound/scrape-feed.js';
import { generateOutboundComment } from '../outbound/generate-comment.js';
import { relevanceHits } from '../outbound/relevance.js';
import { isSessionExpiredUrl } from '../poster/index.js';

const llmClient = new Anthropic();
import {
  getActiveProfiles,
  getProfilesByPriority,
  isPostSeen,
  markPostSeen,
  addPendingComment,
  recordOutboundPoll,
  updateProfileName,
  recordProfilePollResult,
  storeFallbackCandidate,
  storeRankedCandidates,
  popNextRankedCandidate,
  hasRankedCandidates,
  hoursSinceLastComment,
  type OutboundProfile,
  type PendingComment,
  type CandidatePost,
} from '../outbound/outbound-queue.js';
import { getOrganicProfileBonus } from '../analytics/organic-attribution.js';
import { notifyOutboundComment, sendMessage } from './telegram.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const HASHTAG_TRENDS_FILE = 'hashtag_trends.json';

interface HashtagEntry {
  count: number;        // total sightings
  profiles: Record<string, number>;  // profileName → count
  lastSeen: string;     // ISO date
}

function recordHashtagSightings(tags: string[], profileName: string): void {
  let trends: Record<string, HashtagEntry> = {};
  try {
    if (existsSync(HASHTAG_TRENDS_FILE)) {
      trends = JSON.parse(readFileSync(HASHTAG_TRENDS_FILE, 'utf-8'));
    }
  } catch {}

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  for (const raw of tags) {
    // Normalize: lowercase the tag for dedup, but store original casing on first sight
    const key = raw.toLowerCase();
    if (!trends[key]) {
      trends[key] = { count: 0, profiles: {}, lastSeen: today };
    }
    trends[key].count++;
    trends[key].profiles[profileName] = (trends[key].profiles[profileName] ?? 0) + 1;
    trends[key].lastSeen = today;
  }

  // Prune entries not seen in 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  for (const [key, entry] of Object.entries(trends)) {
    if (entry.lastSeen < cutoffStr) delete trends[key];
  }

  writeFileSync(HASHTAG_TRENDS_FILE, JSON.stringify(trends, null, 2));
}

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

type CandidateSource = 'profile' | 'hashtag';

interface Candidate extends ScrapedPost {
  profile: OutboundProfile | null; // null for hashtag-sourced posts
  source: CandidateSource;
  sourceLabel: string;             // profile name or #hashtag
}

const POLL_TIME_LIMIT_MS = 2 * 60 * 1000; // 2 minutes — hard cutoff for profile scraping
const COMMENT_COOLDOWN_HOURS = 24; // 1 day — won't queue a comment for a profile within this window

/**
 * Score a batch of candidate posts using an LLM for relevance.
 * Returns a Map of candidate index → score (1–10).
 * Candidates with zero keyword hits are pre-filtered to avoid wasting tokens.
 */
async function scoreCandidatesWithLLM(
  candidates: Array<{ text: string; authorName: string; keywordHits: number; index: number }>,
): Promise<Map<number, number>> {
  const scores = new Map<number, number>();

  // Pre-filter: candidates with zero keyword hits get score 0 (clearly off-topic)
  const toScore = candidates.filter(c => {
    if (c.keywordHits === 0) {
      scores.set(c.index, 0);
      return false;
    }
    return true;
  });

  if (toScore.length === 0) return scores;

  // Strip broken Unicode surrogates that would produce invalid JSON for the API
  const sanitizeText = (t: string) => t.replace(/[\uD800-\uDFFF]/g, '');

  // Batch all candidates into one LLM call for efficiency
  const postList = toScore.map((c, i) =>
    `POST ${i + 1} (by ${c.authorName}):\n"${sanitizeText(c.text.slice(0, 400))}"`
  ).join('\n\n');

  try {
    const message = await llmClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are scoring LinkedIn posts for an AI developer who works in the nuclear industry (building AI tools for nuclear operators at NPX). He comments on posts where he can add genuine value from his unique position at the intersection of AI and nuclear/regulated industries.

Score each post from 1 to 10 on how much value he could add in a comment. Consider:
- Does this topic intersect with AI, nuclear, energy, regulated industries, or change management?
- Would someone with his background have a unique angle that general commenters wouldn't?
- Is this a substantive post worth engaging with, or shallow/promotional content?
- A high score means he'd have something genuinely insightful to say, not just that the topic overlaps with his field.

${postList}

Return ONLY a JSON array of scores in order, e.g. [7, 3, 8]. One number per post, nothing else.`,
      }],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
    const parsed = JSON.parse(raw.match(/\[[\d\s,]+\]/)?.[0] ?? '[]') as number[];

    for (let i = 0; i < toScore.length && i < parsed.length; i++) {
      const score = Math.max(0, Math.min(10, parsed[i]));
      scores.set(toScore[i].index, score);
    }

    // If LLM returned fewer scores than expected, fall back to keyword-based for the rest
    for (let i = parsed.length; i < toScore.length; i++) {
      scores.set(toScore[i].index, Math.min(toScore[i].keywordHits, 5) * 2);
    }
  } catch (err) {
    console.warn(`  LLM scoring failed (${(err as Error).message}) — falling back to keyword scoring.`);
    for (const c of toScore) {
      scores.set(c.index, Math.min(c.keywordHits, 5) * 2);
    }
  }

  return scores;
}

export async function runOutboundPoll(): Promise<void> {
  // Check if we have a fresh ranked list (within 15 min). If so, serve the next
  // candidate without re-scraping — saves browser time and API tokens.
  if (hasRankedCandidates()) {
    const next = popNextRankedCandidate();
    if (next) {
      console.log(`Outbound poll: serving cached candidate [${next.profileName}] ${next.url}`);
      try {
        const generated = await generateOutboundComment(
          { text: next.text, authorName: next.authorName, url: next.url, articleUrl: next.articleUrl },
          { insider: next.insider, colleague: next.colleague },
        );
        const comment: PendingComment = {
          id: `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          profileUrl: next.profileUrl,
          profileName: next.profileName,
          postUrl: next.url,
          postSnippet: next.text.slice(0, 100),
          postSummary: generated.postSummary,
          postAgeHours: next.ageHours,
          commentOptions: [generated.options[0].text, generated.options[1].text],
          commentLabels: [generated.options[0].label, generated.options[1].label],
          recommendationReason: generated.recommendationReason,
          reasoning: generated.reasoning,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        addPendingComment(comment);
        markPostSeen(next.id);
        await notifyOutboundComment(comment);
        console.log(`  Comment queued from cached list. ${hasRankedCandidates() ? 'More candidates available.' : 'List exhausted.'}`);
      } catch (err) {
        console.error(`  Failed to generate comment from cache: ${(err as Error).message}`);
        await sendMessage(`Outbound (cached): failed to generate comment for ${next.profileName}.\n${(err as Error).message}`).catch(() => {});
      }
      return;
    }
  }

  const allProfiles = getActiveProfiles();
  if (allProfiles.length === 0 && HASHTAGS.length === 0) {
    console.log('Outbound poll: no active profiles or hashtags configured.');
    return;
  }

  // All profiles sorted by priority — check as many as fit within the time limit
  const pollProfiles = getProfilesByPriority(allProfiles.length);

  console.log(`Outbound poll: checking up to ${pollProfiles.length} profile(s) (${POLL_TIME_LIMIT_MS / 1000}s limit) + ${HASHTAGS.length} hashtag(s)...`);

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>(); // deduplicate across profiles and hashtags

  const { context, page, release } = await openScrapeContext(15_000);
  const scrapeStart = Date.now();
  let profilesChecked = 0;

  try {
    // Verify LinkedIn session before scraping
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (isSessionExpiredUrl(page.url())) {
        console.error('Outbound poll: LinkedIn session expired. Run /login to renew.');
        recordOutboundPoll();
        return;
      }
    } catch (err) {
      console.error(`Outbound poll: session check failed (${(err as Error).message}) — aborting.`);
      recordOutboundPoll();
      return;
    }

    // --- Scrape curated profiles (time-bounded) ---
    for (const profile of pollProfiles) {
      if (Date.now() - scrapeStart > POLL_TIME_LIMIT_MS) {
        const deferred = pollProfiles.length - profilesChecked;
        console.log(`  Time limit reached (${POLL_TIME_LIMIT_MS / 1000}s) — ${deferred} profile(s) deferred to next poll.`);
        break;
      }

      let posts;
      try {
        posts = await scrapeProfilePostsWithPage(profile.url, page);
      } catch (err) {
        console.warn(`  Failed to scrape ${profile.name}: ${(err as Error).message}`);
        continue;
      }
      profilesChecked++;

      // Determine the real owner name for repost filtering.
      // Start with stored profile name, but verify against scraped posts.
      // If none match the stored name, the majority author is likely the real owner
      // (stored name may be stale or wrong, e.g. "AIXPERT" vs "Vector Institute").
      let ownerName = profile.name;

      const nameCounts = new Map<string, number>();
      for (const p of posts) {
        if (!p.authorName) continue;
        const lower = p.authorName.toLowerCase();
        nameCounts.set(lower, (nameCounts.get(lower) ?? 0) + 1);
      }

      const storedNameMatches = posts.some(p =>
        p.authorName && p.authorName.toLowerCase() === ownerName.toLowerCase()
      );

      if (!storedNameMatches && posts.length > 0) {
        // Stored name doesn't match any posts — find the majority author
        const mostCommon = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (mostCommon && mostCommon[1] > posts.length / 2) {
          const actualName = posts.find(p => p.authorName?.toLowerCase() === mostCommon[0])?.authorName ?? ownerName;
          console.log(`  ${ownerName} — stored name doesn't match posts, updating to "${actualName}"`);
          updateProfileName(profile.url, actualName);
          ownerName = actualName;
        }
      }

      // Filter out reposts — any post whose author doesn't match the profile owner
      const ownPosts = posts.filter(p =>
        !p.authorName || p.authorName.toLowerCase() === ownerName.toLowerCase()
      );
      const repostCount = posts.length - ownPosts.length;
      if (repostCount > 0) console.log(`  ${ownerName} — skipped ${repostCount} repost(s)`);

      const newPosts = ownPosts.filter(p => !isPostSeen(p.id));
      const ageNote = newPosts.map(p => p.ageHours !== null ? `${p.ageHours.toFixed(1)}h` : '?h').join(', ');
      console.log(`  ${ownerName} — ${ownPosts.length} original post(s) < 24h, ${newPosts.length} new${newPosts.length ? ` (${ageNote})` : ''}`);

      recordProfilePollResult(profile.url, newPosts.length > 0);

      // Extract hashtags from all original posts for trend tracking
      for (const p of ownPosts) {
        const tags = p.text.match(/#[A-Za-z]\w*/g);
        if (tags) recordHashtagSightings(tags, ownerName);
      }

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
    release();
  }

  if (candidates.length === 0) {
    console.log('No new posts found. Nothing queued.');
    await sendMessage(`📤 Outbound poll complete — ${profilesChecked} profile(s) checked, no new posts found.`).catch(() => {});
    recordOutboundPoll();
    return;
  }

  // --- Pre-compute keyword hits and cooldowns ---
  const preScored = candidates.map((c, index) => {
    const postAge = c.ageHours ?? 24;
    const profileCooldown = c.source === 'profile'
      ? hoursSinceLastComment(c.profile!.url)
      : Infinity;
    const keywords = relevanceHits(c.text);
    return { candidate: c, index, postAge, profileCooldown, keywords };
  });

  // Rescue: for candidates with zero keyword hits but an article link,
  // fetch the article and re-score using the combined text.
  const zeroHitWithArticle = preScored.filter(s => s.keywords === 0 && s.candidate.articleUrl);
  if (zeroHitWithArticle.length > 0) {
    console.log(`  ${zeroHitWithArticle.length} candidate(s) with 0 keyword hits have article links — fetching...`);
    const { fetchArticle } = await import('../content/fetch-article.js');
    for (const s of zeroHitWithArticle) {
      try {
        const article = await fetchArticle(s.candidate.articleUrl!);
        if (article.fullText && article.fullText.length > 100) {
          const articleKeywords = relevanceHits(article.fullText);
          if (articleKeywords > 0) {
            console.log(`    ${s.candidate.authorName}: article "${article.title?.slice(0, 50)}" → ${articleKeywords} keyword hit(s) (rescued)`);
            s.keywords = articleKeywords;
          }
        }
      } catch (err) {
        // Non-fatal — candidate stays at 0 hits and gets filtered
      }
    }
  }

  // Hard filters (apply before LLM to save tokens):
  // 1. Profile candidates within comment cooldown — skip (prevents spam)
  // 2. Hashtag candidates with zero keyword hits — skip (strangers posting off-topic)
  const filteredForScoring = preScored.filter(s => {
    if (s.profileCooldown < COMMENT_COOLDOWN_HOURS) {
      console.log(`  Skipping ${s.candidate.authorName || s.candidate.sourceLabel} — commented ${s.profileCooldown.toFixed(0)}h ago (cooldown: ${COMMENT_COOLDOWN_HOURS}h).`);
      return false;
    }
    if (s.candidate.source === 'hashtag' && s.keywords === 0) return false;
    return true;
  });

  if (filteredForScoring.length === 0) {
    console.log(`  ${preScored.length} candidate(s) found but none were eligible. Nothing queued.`);
    await sendMessage(`📤 Outbound poll complete — ${profilesChecked} profile(s) checked, ${preScored.length} candidate(s) found, 0 eligible (cooldown). Nothing queued.`).catch(() => {});
    recordOutboundPoll();
    return;
  }

  // --- LLM relevance scoring ---
  console.log(`  Scoring ${filteredForScoring.length} candidate(s) with LLM...`);
  const llmScores = await scoreCandidatesWithLLM(
    filteredForScoring.map(s => ({
      text: s.candidate.text,
      authorName: s.candidate.authorName,
      keywordHits: s.keywords,
      index: s.index,
    })),
  );

  // --- Final scoring: LLM relevance drives selection, recency and diversity as tiebreakers ---
  const eligible = filteredForScoring.map(s => {
    const llmScore = llmScores.get(s.index) ?? 0;
    const postAge = s.postAge;

    // LLM relevance: 0–1 (normalized from 1–10 scale)
    const relevanceScore = llmScore / 10;

    // Recency: soft tiebreaker — gentle decay over 24h, not a hard cutoff
    const recencyScore = 1 - Math.min(postAge / 24, 1);

    // Diversity: 0–1 (1 = never commented or cooldown elapsed, 0 = just commented)
    const diversityScore = s.profileCooldown >= COMMENT_COOLDOWN_HOURS ? 1 : s.profileCooldown / COMMENT_COOLDOWN_HOURS;

    // Attribution score: organic follow-per-comment data, normalized 0–1
    const profileUrl = s.candidate.profile?.url ?? '';
    const attributionScore = profileUrl ? getOrganicProfileBonus(profileUrl) : 0;

    // Weighted: 40% LLM relevance, 30% attribution, 15% recency, 15% diversity
    let score = relevanceScore * 0.40 + attributionScore * 0.30 + recencyScore * 0.15 + diversityScore * 0.15;

    return { candidate: s.candidate, score, postAge, profileCooldown: s.profileCooldown, keywords: s.keywords, llmScore };
  }).filter(s => s.llmScore >= 4); // Drop posts the LLM scored below 4/10

  if (eligible.length === 0) {
    console.log(`  ${filteredForScoring.length} candidate(s) scored but none reached LLM relevance threshold (4/10). Nothing queued.`);
    await sendMessage(`📤 Outbound poll complete — ${profilesChecked} profile(s) checked, ${filteredForScoring.length} candidate(s) scored, 0 above relevance threshold. Nothing queued.`).catch(() => {});
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
  console.log(`  Picked: [${best.authorName || best.sourceLabel}] ${ageLabel}${inGoldenWindow ? ' ⚡ golden window' : ''} | LLM: ${pick.llmScore}/10 (${pick.keywords} kw) | ${sourceTag} | last comment: ${cooldownLabel}`);

  // Store the full ranked list (minus the winner) for caching and skip flow.
  // Converts internal Candidate objects to CandidatePost for storage.
  const remaining: CandidatePost[] = eligible.slice(1).map(s => ({
    id: s.candidate.id,
    url: s.candidate.url,
    text: s.candidate.text,
    authorName: s.candidate.authorName,
    ageHours: s.candidate.ageHours,
    profileUrl: s.candidate.profile?.url ?? '',
    profileName: s.candidate.profile?.name ?? s.candidate.authorName,
    insider: s.candidate.profile?.insider ?? false,
    colleague: s.candidate.profile?.colleague ?? false,
    articleUrl: s.candidate.articleUrl,
  }));
  storeRankedCandidates(remaining);
  console.log(`  Cached ${remaining.length} remaining candidate(s) for next 15 min.`);

  markPostSeen(best.id);

  // Hashtag posts are from strangers — avoid counterpoint, lean toward ask-question / add-context
  const isStranger = best.source === 'hashtag';
  let generated;
  try {
    generated = await generateOutboundComment(
      { text: best.text, authorName: best.authorName, url: best.url, articleUrl: best.articleUrl },
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
