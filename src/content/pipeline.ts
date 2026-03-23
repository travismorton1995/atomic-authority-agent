import { fetchLatestItems, FeedItem } from './rss.js';
import { fetchArticle } from './fetch-article.js';
import { synthesizePost } from './synthesize.js';
import { screenPost } from './screen.js';
import { verifyPost } from './verify.js';
import { addPendingPost, getSourceHistory, PendingPost } from '../hitl/queue.js';
import { notifyTelegram } from '../hitl/telegram.js';
import { pickPostType, PostType, POST_TYPE_WEIGHTS } from './persona.js';
import { rankItems } from './rank.js';
import { readFileSync, existsSync } from 'fs';

export interface PipelineOptions {
  url?: string;
  topic?: string;
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
    // Clamp between 0.25 and 2.0 so no type is ever fully suppressed or overwhelms
    multipliers[type] = Math.min(2.0, Math.max(0.25, targetShare / Math.max(actualShare, 0.01)));
  }

  return multipliers as Record<PostType, number>;
}

async function finalize(item: FeedItem, postType: PostType): Promise<PendingPost> {
  console.log(`Post type: ${postType}`);

  console.log('Synthesizing draft...');
  let draft = await synthesizePost(item, postType);

  if (item.fullText) {
    console.log('Verifying factual claims...');
    const verification = await verifyPost(draft.content, item.fullText);
    if (verification.changed) {
      console.log(`Verifier corrected ${verification.flaggedClaims.length} claim(s):`);
      for (const claim of verification.flaggedClaims) console.log(`  - ${claim}`);
      draft = { ...draft, content: verification.correctedContent };
    } else {
      console.log('Verification passed — no corrections needed.');
    }
  }

  console.log('Running screening agent...');
  const screening = await screenPost(draft);

  console.log(`Cringe score: ${screening.cringeScore}/10 — ${screening.reasoning}`);
  if (screening.cringeScore > 3 && screening.revisedContent) {
    console.log('Auto-revised by screener.');
  }

  const post = addPendingPost(draft, screening);
  console.log(`Draft saved as ID: ${post.id}`);

  await notifyTelegram(post);
  console.log('Done. Awaiting your approval.');

  return post;
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PendingPost> {
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

  console.log('Fetching RSS feeds...');
  const items = await fetchLatestItems(3);

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

  // Score each article+type combo: article score × balance multiplier × recency multiplier
  // Exclude the last post type to enforce rotation
  const now = Date.now();
  const candidates = ranked
    .filter(r => r.score > 0)
    .map(r => {
      const suggested = r.suggestedPostType as PostType;
      const postType = (suggested && suggested !== lastPostType)
        ? suggested
        : pickPostType(lastPostType);
      const multiplier = balanceMultipliers[postType] ?? 1.0;

      const ageDays = r.item.pubDate
        ? Math.floor((now - new Date(r.item.pubDate).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const recencyMultiplier =
        ageDays === null ? 1.0
        : ageDays <= 1   ? 1.5
        : ageDays <= 3   ? 1.0
        : ageDays <= 7   ? 0.8
        : ageDays <= 14  ? 0.6
        :                  0.4;

      const combinedScore = r.score * multiplier * recencyMultiplier;
      return { item: r.item, postType, articleScore: r.score, combinedScore, recencyMultiplier, reasoning: r.reasoning };
    });

  candidates.sort((a, b) => b.combinedScore - a.combinedScore);

  if (candidates.length === 0) throw new Error('No candidates after scoring. All articles may have scored 0.');

  const top = candidates[0];

  console.log(`Selected: "${top.item.title}" (${top.item.source})`);
  console.log(`Score: ${top.articleScore}/10 — ${top.reasoning}`);
  console.log(`Balance multiplier: ${balanceMultipliers[top.postType].toFixed(2)}x | Recency multiplier: ${top.recencyMultiplier.toFixed(2)}x`);

  // Fetch full article body so Claude has specific facts, quotes, and figures to work with
  if (top.item.link && !top.item.fullText) {
    try {
      console.log('Fetching full article text...');
      const fetched = await fetchArticle(top.item.link);
      if (fetched.fullText) top.item.fullText = fetched.fullText;
    } catch {
      console.warn('Could not fetch full article text — will use RSS summary only.');
    }
  }

  return finalize(top.item, top.postType);
}
