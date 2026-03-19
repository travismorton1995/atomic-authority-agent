import { fetchLatestItems } from './rss.js';
import { synthesizePost } from './synthesize.js';
import { screenPost } from './screen.js';
import { addPendingPost, getSourceHistory, PendingPost } from '../hitl/queue.js';
import { notifyTelegram } from '../hitl/telegram.js';
import { pickPostType } from './persona.js';
import { rankItems } from './rank.js';
import { readFileSync, existsSync } from 'fs';

function getRecentTitles(limit = 10): string[] {
  if (!existsSync('posted_history.json')) return [];
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    return history.slice(-limit).map((p: any) => p.draft?.sourceTitle ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

function getLastPostType(): string | undefined {
  if (!existsSync('posted_history.json')) return undefined;
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    if (history.length === 0) return undefined;
    return history[history.length - 1].draft?.postType;
  } catch {
    return undefined;
  }
}

export async function runPipeline(): Promise<PendingPost> {
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
  const item = top.item;
  const lastPostType = getLastPostType() as any;
  const suggested = top.suggestedPostType as any;
  const postType = suggested && suggested !== lastPostType
    ? suggested
    : pickPostType(lastPostType);

  console.log(`Selected: "${item.title}" (${item.source})`);
  console.log(`Score: ${top.score}/10 — ${top.reasoning}`);
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
