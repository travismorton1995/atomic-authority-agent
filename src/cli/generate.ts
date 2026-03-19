import 'dotenv/config';
import { fetchLatestItems } from '../content/rss.js';
import { synthesizePost } from '../content/synthesize.js';
import { screenPost } from '../content/screen.js';
import { addPendingPost, getSourceHistory } from '../hitl/queue.js';
import { notifyDiscord } from '../hitl/notify.js';
import { pickPostType } from '../content/persona.js';
import { rankItems } from '../content/rank.js';
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

async function generate() {
  console.log('Fetching RSS feeds...');
  const items = await fetchLatestItems(5);

  if (items.length === 0) {
    console.error('No feed items found. Check network or feed URLs.');
    process.exit(1);
  }

  console.log(`Ranking ${items.length} articles...`);
  const { excludedTitles, rejectedSources } = getSourceHistory();
  const ranked = await rankItems(items, {
    recentTitles: getRecentTitles(),
    excludedTitles,
    rejectedSources,
  });

  if (ranked.length === 0) {
    console.error('No eligible articles after filtering pending/approved sources.');
    process.exit(1);
  }

  ranked.sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const item = top.item;
  const postType = top.suggestedPostType as any ?? pickPostType();

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

  await notifyDiscord(post);
  console.log('Done. Awaiting your approval.');
}

generate().catch(err => {
  console.error(err);
  process.exit(1);
});
