import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';
import { CONTENT_TAGS, ContentTag } from './synthesize.js';

const client = new Anthropic();

export interface ScoreBreakdown {
  intersection: number; // 0–4
  novelty: number;      // 0–3
  geography: number;    // 0–2
  npx: number;          // 0–1
}

export interface RankedItem {
  item: FeedItem;
  score: number;        // computed: intersection + novelty + geography + npx
  breakdown: ScoreBreakdown;
  reasoning: string;
  suggestedPostType: string;
  suggestedTags: ContentTag[];
}

const RANKER_SYSTEM = `You are an editorial ranker for a LinkedIn content account at the intersection of AI and nuclear energy.

The account persona is Travis Morton — a professional AI developer working in the nuclear sector. His audiences rotate between:
- Nuclear professionals (regulatory, operations, engineering)
- AI developers curious about regulated industries
- Executives and decision-makers in energy

Score each article using this EXACT rubric. Sub-scores must be integers within the stated range.

NUCLEAR/AI INTERSECTION (0–4):
4 = Both nuclear AND AI explicitly and specifically intersected (e.g. AI tool deployed for nuclear licensing, ML applied to reactor inspection data, LLM-based document automation for safety cases)
3 = One domain primary, the other clearly implied but not the article's focus (e.g. NRC approves digital I&C framework — AI implication is obvious; AI safety framework for critical infrastructure — nuclear is the clearest application)
2 = One domain primary, weak or tangential connection to the other (e.g. nuclear construction milestone — AI angle requires a stretch; general AI product news — nuclear application requires a significant leap)
1 = Single domain only, no meaningful cross-domain angle (pure nuclear operations news, pure AI product release)
0 = Neither domain meaningfully present (geopolitical, administrative, off-topic)

NOVELTY / SURPRISE (0–3):
3 = First-of-kind event, regulatory milestone, surprising statistic, counterintuitive finding
2 = Notable development or meaningful industry progress
1 = Incremental update or routine news
0 = Press release fluff, generic op-ed, conference announcement

GEOGRAPHIC RELEVANCE (0–2):
2 = Canadian angle: CNSC, Bruce Power, CNL, OPG, NB Power, Ontario, or Canadian companies/policy
1 = US or North American angle: NRC, US utilities, US nuclear policy, or American companies
0 = International or no geographic specificity (IAEA, UK, France, Ukraine, etc.)

NPX MENTION (0–1):
1 = "NPX" or "Nuclear Promise X" appears anywhere in the article title or summary
0 = Not mentioned

POST TYPE MATCHING — assign the best type based on these signals:
- bridge: regulatory approval, partnership announcement, new build milestone, technology deployment — something happened that connects nuclear and AI concretely
- contrarian: article reflects mainstream AI culture (speed, iteration, disruption) that conflicts with nuclear's engineering discipline
- change-management: workforce adoption friction, trust gaps, org culture, training, or human factors in AI deployment
- explainer: complex nuclear or AI concept that the other audience wouldn't know — licensing, reactor physics, model validation, safety cases
- myth-busting: article touches a widespread misconception about nuclear or AI — public fear, overhype, or a common misunderstanding
- prediction: major industry shift, policy direction, or technology trajectory with clear 12-24 month implications
- hot-take: surprising statistic, frustrating decision, or a strong opinion the article clearly warrants

Respond ONLY with a valid JSON array — no markdown, no extra text before or after. One entry per article, in the same order as input:
[
  {
    "intersection": <0-4>,
    "novelty": <0-3>,
    "geography": <0-2>,
    "npx": <0-1>,
    "reasoning": "<one sentence explaining the intersection score>",
    "suggestedPostType": "<bridge|contrarian|change-management|explainer|myth-busting|prediction|hot-take>",
    "suggestedTags": ["<tag1>", "<tag2>"]
  }
]

For suggestedTags, pick 3–5 from this exact list only: regulatory, safety-case, licensing, cnsc, nrc, iaea, smr, candu, reactor-design, decommissioning, new-build, fusion, llm, machine-learning, digital-twin, anomaly-detection, document-automation, explainability, change-management, workforce, trust, adoption, canada, usa, uk, cybersecurity, public-opinion`;

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
    const parsedMs = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
    const ageDays = isNaN(parsedMs) ? null : Math.floor((now - parsedMs) / (1000 * 60 * 60 * 24));
    const ageLabel = ageDays === null ? 'age unknown' : ageDays === 0 ? 'today' : `${ageDays}d old`;
    return `${i + 1}. [${item.source}] [${ageLabel}] ${item.title}\n   ${item.summary?.slice(0, 200) ?? ''}`.trim();
  }).join('\n\n');

  const historyNote = context.recentTitles.length > 0
    ? `\nRECENTLY POSTED (avoid repeating these topics):\n${context.recentTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const rejectedNote = context.rejectedSources.length > 0
    ? `\nPREVIOUSLY REJECTED (source was used but post was rejected — suggest a DIFFERENT post type):\n${context.rejectedSources.map(s => `- "${s.title}" (was tried as: ${s.usedPostType})`).join('\n')}`
    : '';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 6144,
    system: RANKER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Score these ${eligible.length} articles:${historyNote}${rejectedNote}\n\nARTICLES:\n${articleList}`,
    }],
  });

  const rawText = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    console.warn('Ranker response contained no JSON array. Raw response:', rawText.slice(0, 500));
  }
  const raw = arrayMatch ? arrayMatch[0].trim() : '[]';

  try {
    const scores = JSON.parse(raw) as Array<{
      intersection: number;
      novelty: number;
      geography: number;
      npx: number;
      reasoning: string;
      suggestedPostType: string;
      suggestedTags?: string[];
    }>;

    if (scores.length < eligible.length) {
      console.warn(`Ranker returned ${scores.length} scores for ${eligible.length} articles — missing entries will default to score 1.`);
    }

    return eligible.map((item, i) => {
      const s = scores[i];
      const breakdown: ScoreBreakdown = {
        intersection: s?.intersection ?? 0,
        novelty:      s?.novelty      ?? 0,
        geography:    s?.geography    ?? 0,
        npx:          s?.npx          ?? 0,
      };
      const score = breakdown.intersection + breakdown.novelty + breakdown.geography + breakdown.npx;
      return {
        item,
        score: s ? score : 1,
        breakdown,
        reasoning: s?.reasoning ?? 'No reasoning provided',
        suggestedPostType: s?.suggestedPostType ?? 'bridge',
        suggestedTags: (s?.suggestedTags ?? []).filter((t): t is ContentTag => (CONTENT_TAGS as readonly string[]).includes(t)),
      };
    });
  } catch {
    console.error('Ranker returned non-JSON response:', raw);
    return eligible.map(item => ({
      item,
      score: 1,
      breakdown: { intersection: 0, novelty: 0, geography: 0, npx: 0 },
      reasoning: 'Ranker error — fallback score',
      suggestedPostType: 'bridge',
      suggestedTags: [],
    }));
  }
}
