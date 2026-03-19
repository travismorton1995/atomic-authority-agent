import { fetchLatestItems, FeedItem } from './rss.js';
import { fetchArticle } from './fetch-article.js';
import { synthesizePost } from './synthesize.js';
import { screenPost } from './screen.js';
import { addPendingPost, getSourceHistory, PendingPost } from '../hitl/queue.js';
import { notifyTelegram } from '../hitl/telegram.js';
import { pickPostType, PostType } from './persona.js';
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

async function finalize(item: FeedItem, postType: PostType): Promise<PendingPost> {
  console.log(`Post type: ${postType}`);

  console.log('Synthesizing draft...');
  const draft = await synthesizePost(item, postType);

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
  const items = await fetchLatestItems(5);

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

  ranked.sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const suggested = top.suggestedPostType as PostType;
  const postType = suggested && suggested !== lastPostType
    ? suggested
    : pickPostType(lastPostType);

  console.log(`Selected: "${top.item.title}" (${top.item.source})`);
  console.log(`Score: ${top.score}/10 — ${top.reasoning}`);

  return finalize(top.item, postType);
}
