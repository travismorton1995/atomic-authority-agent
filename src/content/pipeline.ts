import { fetchLatestItems, FeedItem } from './rss.js';
import { fetchNewsDataItems } from './newsdata.js';
import { fetchArticle } from './fetch-article.js';
import { synthesizePost } from './synthesize.js';
import { screenPost } from './screen.js';
import { verifyPost } from './verify.js';
import { addPendingPost, getSourceHistory, cancelPost, PendingPost } from '../hitl/queue.js';
import { notifyTelegram } from '../hitl/telegram.js';
import { pickPostType, PostType, POST_TYPE_WEIGHTS } from './persona.js';
import { rankItems, ScoreBreakdown } from './rank.js';
import { addUnverifiedMentions } from '../poster/mentions.js';
import { CONTENT_TAGS, ContentTag } from './synthesize.js';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const anthropic = new Anthropic();

let pipelineRunning = false;

// Strip [[MENTION:X]] markers from text, returning cleaned text and the marker positions.
function stripMentionMarkers(text: string): { clean: string; markers: Array<{ name: string; plainName: string }> } {
  const markers: Array<{ name: string; plainName: string }> = [];
  const clean = text.replace(/\[\[MENTION:([^\]]+)\]\]/g, (_, name) => {
    markers.push({ name, plainName: name });
    return name;
  });
  return { clean, markers };
}

// Re-inject [[MENTION:X]] markers into revised text — first occurrence only,
// and never inside a hashtag. Longest names matched first to avoid partials.
function reInjectMentionMarkers(revised: string, markers: Array<{ name: string; plainName: string }>): string {
  if (markers.length === 0) return revised;
  const names = [...new Set(markers.map(m => m.name))].sort((a, b) => b.length - a.length);
  let result = revised;
  for (const name of names) {
    const marker = `[[MENTION:${name}]]`;
    if (result.includes(marker)) continue; // already injected
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace first whole-word occurrence that isn't preceded by #
    result = result.replace(new RegExp(`(?<!#)\\b${escaped}\\b`), marker);
  }
  // Strip any markers that ended up inside hashtags (e.g. #[[MENTION:NPX]])
  result = result.replace(/#\[\[MENTION:([^\]]+)\]\]/g, '#$1');
  return result;
}

export interface PipelineOptions {
  url?: string;
  topic?: string;
}

const CANDIDATES_FILE = 'candidates.json';
const CANDIDATES_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ScoredCandidate {
  item: FeedItem;
  postType: PostType;
  articleScore: number;
  scoreBreakdown: ScoreBreakdown;
  balanceMultiplier: number;
  recencyMultiplier: number;
  postContentFeedback: number;
  combinedScore: number;
  reasoning: string;
}

interface CandidateStore {
  generatedAt: string;
  nextIndex: number;
  candidates: ScoredCandidate[];
}

function loadCandidateStore(): CandidateStore | null {
  if (!existsSync(CANDIDATES_FILE)) return null;
  try {
    const store = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf-8')) as CandidateStore;
    if (Date.now() - new Date(store.generatedAt).getTime() > CANDIDATES_TTL_MS) return null;
    return store;
  } catch {
    return null;
  }
}

export function clearCandidateStore(): void {
  if (existsSync(CANDIDATES_FILE)) unlinkSync(CANDIDATES_FILE);
}

function getRecentTitles(limit = 10): string[] {
  if (!existsSync('posted_history.json')) return [];
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    return history.slice(-limit).map((p: any) => p.draft?.sourceTitle ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

function getLastPostType(): PostType | undefined {
  if (!existsSync('posted_history.json')) return undefined;
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    if (history.length === 0) return undefined;
    return history[history.length - 1].draft?.postType;
  } catch {
    return undefined;
  }
}

// Returns a balance multiplier (0-2) for each post type based on how underused
// it is relative to its target weight across recent posts.
// Types used less than their target share score above 1.0 (boosted).
// Types used more than their target share score below 1.0 (suppressed).
function getTypeBalanceMultipliers(lookback = 14): Record<PostType, number> {
  const weights = POST_TYPE_WEIGHTS;
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const counts: Record<string, number> = {};
  for (const type of Object.keys(weights)) counts[type] = 0;

  if (existsSync('posted_history.json')) {
    try {
      const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
      history.slice(-lookback).forEach((p: any) => {
        const t = p.draft?.postType;
        if (t && t in counts) counts[t]++;
      });
    } catch {}
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const multipliers: Record<string, number> = {};

  for (const [type, weight] of Object.entries(weights)) {
    const targetShare = weight / totalWeight;
    const actualShare = total > 0 ? (counts[type] ?? 0) / total : 0;
    // Clamp between 0.8 and 1.2 — article quality should dominate, balance is a light nudge
    multipliers[type] = Math.min(1.2, Math.max(0.8, targetShare / Math.max(actualShare, 0.01)));
  }

  return multipliers as Record<PostType, number>;
}

// Returns average engagement score per content tag across all posts with metrics.
function getTagEngagementScores(): Record<string, number> {
  const scores: Record<string, number[]> = {};

  if (existsSync('posted_history.json')) {
    try {
      const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
      for (const p of history) {
        const tags: string[] = p.draft?.contentTags ?? [];
        const m = p.metrics;
        if (!m || tags.length === 0) continue;
        const engagement = (m.reactions ?? 0) + (m.comments ?? 0) + (m.reposts ?? 0);
        for (const tag of tags) {
          if (!scores[tag]) scores[tag] = [];
          scores[tag].push(engagement);
        }
      }
    } catch {}
  }

  const averages: Record<string, number> = {};
  for (const [tag, vals] of Object.entries(scores)) {
    if (vals.length < 2) continue; // require at least 2 posts before a tag is eligible
    averages[tag] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return averages;
}

// Given an article's suggested tags and historical tag scores, returns a
// 1.0–1.25 post-content feedback multiplier. Articles whose tags historically
// perform above average get a boost; no penalty for below average.
// Falls back to 1.0 when there is no data yet.
function computePostContentFeedback(tags: string[], tagScores: Record<string, number>): number {
  if (tags.length === 0 || Object.keys(tagScores).length === 0) return 1.0;
  const globalAvg = Object.values(tagScores).reduce((a, b) => a + b, 0) / Object.values(tagScores).length;
  if (globalAvg === 0) return 1.0;
  const matched = tags.filter(t => tagScores[t] !== undefined);
  if (matched.length === 0) return 1.0;
  const avgScore = matched.reduce((a, t) => a + tagScores[t], 0) / matched.length;
  return Math.min(1.25, Math.max(1.0, avgScore / globalAvg));
}


async function generateContentTags(content: string): Promise<ContentTag[]> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Tag this LinkedIn post with all relevant labels from the list below. Apply as many as genuinely fit — there is no upper limit, but do not force tags that are only loosely related. Return ONLY a valid JSON array of strings using exact values from the list — no other text.\n\nAllowed tags: ${CONTENT_TAGS.join(', ')}\n\nPost:\n${content}`,
      }],
    });
    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const tags = JSON.parse(match[0]) as string[];
    return tags.filter((t): t is ContentTag => (CONTENT_TAGS as readonly string[]).includes(t));
  } catch {
    return [];
  }
}

async function extractAndRegisterMentions(content: string): Promise<void> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract all company, organization, and institution names from this text. Include acronyms that refer to specific organizations. Exclude: generic terms, people's names, hashtags, and post types. Return ONLY a valid JSON array of strings, no other text.\n\nText:\n${content}`,
      }],
    });
    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    const names = JSON.parse(match[0]) as string[];
    addUnverifiedMentions(names);
  } catch {
    // Non-critical — don't block the pipeline
  }
}

async function finalize(item: FeedItem, postType: PostType, combinedScore?: number, scoreBreakdown?: ScoreBreakdown, multipliers?: { balance: number; recency: number; postContent: number }): Promise<PendingPost> {
  console.log(`Post type: ${postType}`);

  console.log('Synthesizing draft...');
  let draft = await synthesizePost(item, postType);
  if (combinedScore !== undefined) draft = { ...draft, combinedScore };
  if (scoreBreakdown !== undefined) draft = { ...draft, scoreBreakdown };
  if (multipliers !== undefined) draft = { ...draft, balanceMultiplier: multipliers.balance, recencyMultiplier: multipliers.recency, postContentFeedback: multipliers.postContent };

  // Strip [[MENTION:X]] markers before passing to verifier/screener so they
  // see clean prose. Markers are re-injected into any revised output afterward.
  const { clean: cleanContent, markers } = stripMentionMarkers(draft.content);

  if (item.fullText) {
    console.log('Verifying factual claims...');
    const verification = await verifyPost(cleanContent, item.fullText);
    if (verification.changed) {
      console.log(`Verifier corrected ${verification.flaggedClaims.length} claim(s):`);
      for (const claim of verification.flaggedClaims) console.log(`  - ${claim}`);
      draft = { ...draft, content: reInjectMentionMarkers(verification.correctedContent, markers) };
    } else {
      console.log('Verification passed — no corrections needed.');
      draft = { ...draft, content: reInjectMentionMarkers(cleanContent, markers) };
    }
  }

  console.log('Running screening agent...');
  const screeningDraft = { ...draft, content: stripMentionMarkers(draft.content).clean };
  const screening = await screenPost(screeningDraft);

  console.log(`Cringe score: ${screening.cringeScore}/10 — ${screening.reasoning}`);
  if (screening.cringeScore > 3 && screening.revisedContent) {
    // Re-inject markers into the screener's revised content
    screening.revisedContent = reInjectMentionMarkers(screening.revisedContent, markers);
    console.log('Auto-revised by screener.');
  }

  // Tag the final content and store on draft before saving
  const contentTags = await generateContentTags(stripMentionMarkers(draft.content).clean);
  if (contentTags.length > 0) {
    draft = { ...draft, contentTags };
    console.log(`Content tags: ${contentTags.join(', ')}`);
  }

  const post = addPendingPost(draft, screening);
  console.log(`Draft saved as ID: ${post.id}`);

  // Extract and register any company names not yet in the mentions dictionary
  await extractAndRegisterMentions(post.finalContent);

  await notifyTelegram(post);
  console.log('Done. Awaiting your approval.');

  return post;
}

async function fetchAndFinalize(candidate: ScoredCandidate): Promise<PendingPost> {
  console.log(`Selected: "${candidate.item.title}" (${candidate.item.source})`);
  const bd = candidate.scoreBreakdown;
  console.log(`Score: ${candidate.articleScore}/10 (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx}) — ${candidate.reasoning}`);
  console.log(`Balance: ${candidate.balanceMultiplier.toFixed(2)}x | Recency: ${candidate.recencyMultiplier.toFixed(2)}x | Post-content feedback: ${candidate.postContentFeedback.toFixed(2)}x | Combined: ${candidate.combinedScore.toFixed(2)}`);

  if (candidate.item.link && (!candidate.item.fullText || !candidate.item.imageUrl)) {
    try {
      console.log('Fetching full article text...');
      const fetched = await fetchArticle(candidate.item.link);
      if (fetched.fullText) candidate.item.fullText = fetched.fullText;
      if (fetched.imageUrl) {
        candidate.item.imageUrl = fetched.imageUrl;
        console.log(`Image found: ${fetched.imageUrl}`);
      }
    } catch {
      console.warn('Could not fetch full article text — will use RSS summary only.');
    }
  }

  return finalize(candidate.item, candidate.postType, candidate.combinedScore, candidate.scoreBreakdown, { balance: candidate.balanceMultiplier, recency: candidate.recencyMultiplier, postContent: candidate.postContentFeedback });
}

// Re-runs synthesis for an existing post — same article, same post type, fresh hooks/text/screening.
export async function rewritePost(post: PendingPost): Promise<PendingPost> {
  if (pipelineRunning) {
    throw new Error('Pipeline already in progress — concurrent calls are not allowed.');
  }
  pipelineRunning = true;
  try {
    console.log(`Rewriting post ${post.id} — "${post.draft.sourceTitle}"`);

    // Reconstruct the FeedItem from the stored draft
    const item: FeedItem = {
      title: post.draft.sourceTitle,
      link: post.draft.sourceUrl,
      summary: '',
      source: post.draft.sourceFeed ?? post.draft.sourceTitle,
      pubDate: post.draft.sourceDate,
      fullText: post.draft.sourceUrl ? undefined : undefined,
      imageUrl: post.draft.imageUrl,
    };

    // Re-fetch full article text if we have a URL
    if (item.link) {
      try {
        console.log('Re-fetching full article text...');
        const fetched = await fetchArticle(item.link);
        if (fetched.fullText) item.fullText = fetched.fullText;
        if (fetched.imageUrl) item.imageUrl = fetched.imageUrl;
      } catch {
        console.warn('Could not fetch full article text — will use summary only.');
      }
    }

    // Cancel the old post
    cancelPost(post.id);
    console.log(`Old post ${post.id} cancelled.`);

    const postType = post.draft.postType as PostType;
    return await finalize(item, postType, post.draft.combinedScore, post.draft.scoreBreakdown,
      post.draft.balanceMultiplier !== undefined ? {
        balance: post.draft.balanceMultiplier,
        recency: post.draft.recencyMultiplier ?? 1,
        postContent: post.draft.postContentFeedback ?? 1,
      } : undefined);
  } finally {
    pipelineRunning = false;
  }
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PendingPost> {
  if (pipelineRunning) {
    throw new Error('Pipeline already in progress — concurrent calls are not allowed.');
  }
  pipelineRunning = true;
  try {
  return await _runPipeline(options);
  } finally {
    pipelineRunning = false;
  }
}

async function _runPipeline(options: PipelineOptions = {}): Promise<PendingPost> {
  const lastPostType = getLastPostType();

  if (options.url) {
    console.log(`Fetching article from URL: ${options.url}`);
    const item = await fetchArticle(options.url);
    console.log(`Using: "${item.title}" (${item.source})`);
    return finalize(item, pickPostType(lastPostType));
  }

  if (options.topic) {
    console.log(`Using manual topic: "${options.topic}"`);
    const item: FeedItem = {
      title: options.topic,
      link: '',
      summary: options.topic,
      source: 'Manual',
      pubDate: new Date().toISOString(),
    };
    return finalize(item, pickPostType(lastPostType));
  }

  // --- Use cached candidates if available and fresh ---
  const store = loadCandidateStore();
  if (store && store.nextIndex < store.candidates.length) {
    const { excludedUrls, excludedTitles } = getSourceHistory();
    let chosen: ScoredCandidate | null = null;
    let nextIndex = store.nextIndex;

    while (nextIndex < store.candidates.length) {
      const c = store.candidates[nextIndex++];
      if (c.item.link && excludedUrls.includes(c.item.link)) continue;
      if (excludedTitles.some(t => t.toLowerCase() === c.item.title.toLowerCase())) continue;
      chosen = c;
      break;
    }

    if (chosen) {
      writeFileSync(CANDIDATES_FILE, JSON.stringify({ ...store, nextIndex }, null, 2));
      console.log(`Using cached candidate ${nextIndex} of ${store.candidates.length} (ranked ${new Date(store.generatedAt).toLocaleTimeString()})`);
      return fetchAndFinalize(chosen);
    }

    console.log('All cached candidates exhausted or excluded — fetching fresh articles...');
  }

  // --- Fresh fetch + rank + score ---
  console.log('Fetching RSS feeds...');
  const rssItems = await fetchLatestItems(5);

  console.log('Fetching NewsData articles...');
  const newsDataItems = await fetchNewsDataItems();

  // Merge and deduplicate by URL
  const seenUrls = new Set<string>();
  const items: FeedItem[] = [];
  for (const item of [...rssItems, ...newsDataItems]) {
    const key = item.link.replace(/\/$/, '').toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    items.push(item);
  }
  console.log(`Total articles: ${items.length} (${rssItems.length} RSS + ${newsDataItems.length} NewsData, ${rssItems.length + newsDataItems.length - items.length} duplicates removed)`);

  if (items.length === 0) throw new Error('No feed items found. Check network or feed URLs.');

  console.log(`Ranking ${items.length} articles...`);
  const { excludedTitles, excludedUrls, rejectedSources } = getSourceHistory();
  const ranked = await rankItems(items, {
    recentTitles: getRecentTitles(),
    excludedTitles,
    excludedUrls,
    rejectedSources,
  });

  if (ranked.length === 0) throw new Error('No eligible articles after filtering pending/approved sources.');

  const balanceMultipliers = getTypeBalanceMultipliers();
  const tagScores = getTagEngagementScores();

  const now = Date.now();
  const scored: ScoredCandidate[] = ranked
    .filter(r => r.score > 0)
    .map(r => {
      const suggested = r.suggestedPostType as PostType;
      const postType = (suggested && suggested !== lastPostType)
        ? suggested
        : pickPostType(lastPostType);
      const balanceMultiplier = balanceMultipliers[postType] ?? 1.0;
      const postContentFeedback = computePostContentFeedback(r.suggestedTags, tagScores);

      const parsedMs = r.item.pubDate ? new Date(r.item.pubDate).getTime() : NaN;
      const ageDays = isNaN(parsedMs) ? null : Math.floor((now - parsedMs) / (1000 * 60 * 60 * 24));
      const recencyMultiplier =
        ageDays === null ? 1.0
        : ageDays <= 1   ? 1.3
        : ageDays <= 3   ? 1.0
        : ageDays <= 7   ? 0.8
        : ageDays <= 14  ? 0.6
        :                  0.4;

      const combinedScore = r.score * balanceMultiplier * recencyMultiplier * postContentFeedback;
      return { item: r.item, postType, articleScore: r.score, scoreBreakdown: r.breakdown, combinedScore, balanceMultiplier, recencyMultiplier, postContentFeedback, reasoning: r.reasoning };
    });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);

  if (scored.length === 0) throw new Error('No candidates after scoring. All articles may have scored 0.');

  // Save full ranked list — next call will start at index 1
  writeFileSync(CANDIDATES_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    nextIndex: 1,
    candidates: scored,
  } satisfies CandidateStore, null, 2));

  return fetchAndFinalize(scored[0]);
}

