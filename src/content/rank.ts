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

export type TypeFitScores = Record<string, number>; // post type → fit score (0–10)

export interface RankedItem {
  item: FeedItem;
  score: number;        // computed: intersection + novelty + geography + npx
  breakdown: ScoreBreakdown;
  reasoning: string;
  suggestedPostType: string; // kept for backward compat — best type from typeFit × weight
  typeFit: TypeFitScores;    // how well this article fits each post type (0–10)
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
3 = First-of-kind event, regulatory milestone, surprising statistic, or counterintuitive finding (e.g. first SMR license issued, unexpected cost data, a reversal of prior policy)
2 = Meaningful but expected progress: a new partnership with specific commitments, a technology demonstration, a funding announcement with real numbers, a notable hire or org change
1 = Incremental update or routine news: a project hitting a previously announced milestone, a scheduled report or review, a restatement of known policy
0 = Press release fluff, generic op-ed, conference announcement, or award

GEOGRAPHIC RELEVANCE (0–2):
2 = Canadian angle: CNSC, Bruce Power, CNL, OPG, NB Power, Ontario, or Canadian companies/policy
1 = US or North American angle: NRC, DOE, US companies, US states, or North American policy. Also use 1 if the article has no specific geography (industry-wide or technology-focused without naming a country)
0 = Explicitly non-North-American: Europe, EU, India, UK, France, Germany, Ukraine, Asia, Middle East, Africa, South Korea, Japan, China, Russia, IAEA, or any other country/region outside North America. If the article names a non-NA geography in the title or first sentence, this MUST be 0 regardless of whether the topic has general relevance

NPX MENTION (0–1):
1 = "NPX" or "Nuclear Promise X" appears anywhere in the article title or summary
0 = Not mentioned

POST TYPE FIT — score how well each article fits EACH post type (0–10). Be generous across multiple types — most articles can work as 3–4 different types. Score based on these signals:
- bridge: A concrete event, decision, or development that connects nuclear and AI. Partnerships, deployments, regulatory changes, technology milestones. The article describes something that HAPPENED.
- contrarian: The article contains a specific claim, assumption, or framing that deserves direct pushback. Works best when the article is optimistic about something that will be harder than claimed, frames a problem/feature incorrectly, or when the consensus view would be wrong. Score LOW if the only possible angle is "nuclear moves slow and that's good" — that is not contrarian.
- change-management: Workforce, organizational, trust, training, or human factors angle. Works when the story is really about people and adoption, not just technology.
- explainer: The article contains a technical concept that one audience (nuclear OR AI) wouldn't know. Works when there's a knowledge bridge to build.
- myth-busting: The article touches on or perpetuates a common misconception about nuclear or AI. Works when there's a wrong belief to correct.
- prediction: The article reveals a trajectory — industry shift, policy direction, or technology trend with implications worth calling out. Works when you can make a specific, time-bounded claim.
- hot-take: The article warrants genuine frustration, pointed disagreement, or a provocative reaction. ONLY score high (7+) if the article is truly outrageous, contradictory, or reveals something that should make people angry. Most routine news does NOT warrant a hot take — score 0–3 for normal articles.

Respond ONLY with a valid JSON array — no markdown, no extra text before or after. One entry per article, in the same order as input:
[
  {
    "intersection": <0-4>,
    "novelty": <0-3>,
    "geography": <0-2>,
    "npx": <0-1>,
    "reasoning": "<one sentence explaining the intersection score>",
    "typeFit": { "bridge": <0-10>, "contrarian": <0-10>, "change-management": <0-10>, "explainer": <0-10>, "myth-busting": <0-10>, "prediction": <0-10>, "hot-take": <0-10> },
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
    max_tokens: 16384,
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
      typeFit?: Record<string, number>;
      suggestedPostType?: string; // legacy fallback
      suggestedTags?: string[];
    }>;

    if (scores.length < eligible.length) {
      console.warn(`Ranker returned ${scores.length} scores for ${eligible.length} articles — missing entries will default to score 1.`);
    }

    const defaultTypeFit: TypeFitScores = { bridge: 5, contrarian: 3, 'change-management': 3, explainer: 5, 'myth-busting': 2, prediction: 3, 'hot-take': 2 };

    return eligible.map((item, i) => {
      const s = scores[i];
      const breakdown: ScoreBreakdown = {
        intersection: s?.intersection ?? 0,
        novelty:      s?.novelty      ?? 0,
        geography:    s?.geography    ?? 0,
        npx:          s?.npx          ?? 0,
      };
      const score = breakdown.intersection + breakdown.novelty + breakdown.geography + breakdown.npx;

      // Use typeFit if provided, fall back to legacy suggestedPostType
      const typeFit: TypeFitScores = s?.typeFit ?? defaultTypeFit;

      // Derive suggestedPostType from highest typeFit score (for backward compat / logging)
      const suggestedPostType = s?.typeFit
        ? Object.entries(typeFit).sort((a, b) => b[1] - a[1])[0][0]
        : (s?.suggestedPostType ?? 'bridge');

      return {
        item,
        score: s ? score : 1,
        breakdown,
        reasoning: s?.reasoning ?? 'No reasoning provided',
        suggestedPostType,
        typeFit,
        suggestedTags: (s?.suggestedTags ?? []).filter((t): t is ContentTag => (CONTENT_TAGS as readonly string[]).includes(t)),
      };
    });
  } catch (err) {
    console.error(`Ranker JSON parse failed (${eligible.length} articles, response length ${raw.length}):`, (err as Error).message);
    console.error('Response start:', raw.slice(0, 200));
    console.error('Response end:', raw.slice(-200));
    const defaultTypeFit: TypeFitScores = { bridge: 5, contrarian: 3, 'change-management': 3, explainer: 5, 'myth-busting': 2, prediction: 3, 'hot-take': 2 };
    return eligible.map(item => ({
      item,
      score: 1,
      breakdown: { intersection: 0, novelty: 0, geography: 0, npx: 0 },
      reasoning: 'Ranker error — fallback score',
      suggestedPostType: 'bridge',
      typeFit: defaultTypeFit,
      suggestedTags: [],
    }));
  }
}
