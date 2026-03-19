import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';

const client = new Anthropic();

export interface RankedItem {
  item: FeedItem;
  score: number;
  reasoning: string;
  suggestedPostType: string;
}

const RANKER_SYSTEM = `You are an editorial strategist for a LinkedIn content account at the intersection of AI and nuclear energy.

The account persona is Travis Morton — a professional AI developer working in the nuclear sector. His audiences rotate between:
- Nuclear professionals (regulatory, operations, engineering)
- AI developers curious about regulated industries
- Executives and decision-makers in energy

His post types (in order of preference): bridge, contrarian, change-management, explainer, hot-take.

Your job is to rank candidate news articles by their potential to generate a strong, authentic LinkedIn post for this persona.

SCORE HIGH (7–10) if the article:
- Directly touches the nuclear/AI intersection
- Has a Canadian or North American angle (CNSC, NRC, Ontario, Bruce Power, CNL, SMRs in Canada)
- Involves regulation, safety culture, or major industry decisions with AI implications
- Has a clear contrarian or surprising angle
- Is 0–3 days old (breaking or very fresh news)

SCORE LOW (1–4) if the article:
- Is purely operational with no AI angle and no broader insight potential
- Is too generic or international with no relevance to the persona's niche
- Covers a topic already recently posted about (check the recent history provided)
- Is 14+ days old unless the topic is evergreen or uniquely relevant

FRESHNESS GUIDANCE: Each article includes its age in days. Prefer articles under 7 days old. An article 0–1 days old that is moderately relevant should outscore a 10-day-old article that is highly relevant. Timeliness matters for LinkedIn engagement.

Respond ONLY in this exact JSON format — an array, one entry per article, in the same order as input:
[
  {
    "score": <number 1-10>,
    "reasoning": "<one sentence>",
    "suggestedPostType": "<bridge|contrarian|change-management|explainer|hot-take>"
  }
]`;

export interface RankContext {
  recentTitles: string[];
  excludedTitles: string[];
  excludedUrls: string[];
  rejectedSources: Array<{ title: string; usedPostType: string }>;
}

export async function rankItems(items: FeedItem[], context: RankContext): Promise<RankedItem[]> {
  // Hard-filter items already pending, approved, or previously posted — by URL first, then title
  const eligible = items.filter(item => {
    if (item.link && context.excludedUrls.includes(item.link)) return false;
    if (context.excludedTitles.some(t => t.toLowerCase() === item.title.toLowerCase())) return false;
    return true;
  });

  if (eligible.length === 0) {
    console.log('All fetched articles are already pending or approved. Nothing to rank.');
    return [];
  }

  const now = Date.now();
  const articleList = eligible.map((item, i) => {
    const ageDays = item.pubDate
      ? Math.floor((now - new Date(item.pubDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const ageLabel = ageDays === null ? 'age unknown' : ageDays === 0 ? 'today' : `${ageDays}d old`;
    return `${i + 1}. [${item.source}] [${ageLabel}] ${item.title}\n   ${item.summary?.slice(0, 200) ?? ''}`.trim();
  }).join('\n\n');

  const historyNote = context.recentTitles.length > 0
    ? `\nRECENTLY POSTED (avoid repeating these topics):\n${context.recentTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const rejectedNote = context.rejectedSources.length > 0
    ? `\nPREVIOUSLY REJECTED (source was used but post was rejected — if this article appears, suggest a DIFFERENT post type than the one listed):\n${context.rejectedSources.map(s => `- "${s.title}" (was tried as: ${s.usedPostType})`).join('\n')}`
    : '';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: RANKER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Rank these ${eligible.length} articles:${historyNote}${rejectedNote}\n\nARTICLES:\n${articleList}`,
    }],
  });

  const rawText = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
  const raw = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const scores = JSON.parse(raw) as Array<{ score: number; reasoning: string; suggestedPostType: string }>;
    return eligible.map((item, i) => ({
      item,
      score: scores[i]?.score ?? 0,
      reasoning: scores[i]?.reasoning ?? '',
      suggestedPostType: scores[i]?.suggestedPostType ?? 'bridge',
    }));
  } catch {
    console.error('Ranker returned non-JSON response:', raw);
    return eligible.map(item => ({ item, score: 0, reasoning: 'Ranker error', suggestedPostType: 'bridge' }));
  }
}
