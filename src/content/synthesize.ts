import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { FeedItem } from './rss.js';
import { PostType, SYSTEM_PROMPT, POST_TYPE_INSTRUCTIONS } from './persona.js';
import { verifiedMentions } from '../poster/mentions.js';

const client = new Anthropic();

export const CONTENT_TAGS = [
  // Regulatory / safety
  'regulatory', 'safety-case', 'licensing', 'cnsc', 'nrc', 'iaea',
  // Reactor / technology
  'smr', 'candu', 'reactor-design', 'decommissioning', 'new-build', 'fusion',
  // AI angle
  'llm', 'machine-learning', 'digital-twin', 'anomaly-detection', 'document-automation', 'explainability',
  // Organizational
  'change-management', 'workforce', 'trust', 'adoption',
  // Geography / other
  'canada', 'uk',
  // US federal & regional
  'usa', 'doe', 'ferc', 'southeast-us', 'midwest-us', 'northeast-us', 'texas', 'appalachia', 'pacific-northwest',
  // Other
  'cybersecurity', 'public-opinion',
] as const;

export type ContentTag = typeof CONTENT_TAGS[number];

export interface DraftPost {
  content: string;
  firstComment: string;
  postType: PostType;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  sourceFeed: string;       // RSS feed name (e.g. "ANS Newswire", "Bruce Power")
  combinedScore?: number;   // article score after all multipliers
  scoreBreakdown?: { intersection: number; novelty: number; geography: number; npx: number };
  balanceMultiplier?: number;
  recencyMultiplier?: number;
  postContentFeedback?: number;
  contentTags?: ContentTag[]; // topic tags for engagement learning
  generatedAt: string;
  imageUrl?: string;
  generatedImagePath?: string; // local path to AI-generated image file
}

const HOOK_THRESHOLD = 7;
const HOOKS_PER_ROUND = 3;
const MAX_HOOK_ROUNDS = 2;

function articleAgeDays(pubDate: string): number | null {
  if (!pubDate) return null;
  const ms = Date.now() - new Date(pubDate).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return isNaN(days) ? null : days;
}

function ageLanguageRule(ageDays: number | null): string {
  if (ageDays === null) return '';
  if (ageDays <= 2) return 'The article is very recent — time-sensitive language ("just announced", "this week") is appropriate.';
  if (ageDays <= 7) return `The article is ${ageDays} days old. Avoid "just" or "today" — use "recently" or past tense at most.`;
  return `The article is ${ageDays} days old. Do NOT use any recency language ("just", "recently", "this week", "new", "breaking"). Write in past tense and frame it as established context, not breaking news.`;
}

async function generateBestHook(item: FeedItem, postType: PostType): Promise<string> {
  let bestHook = '';
  let bestScore = 0;

  const articleSnippet = item.fullText
    ? item.fullText.split(/\s+/).slice(0, 200).join(' ')
    : item.summary?.slice(0, 400) ?? '';

  const ageDays = articleAgeDays(item.pubDate);
  const ageRule = ageLanguageRule(ageDays);

  for (let round = 0; round < MAX_HOOK_ROUNDS; round++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Generate ${HOOKS_PER_ROUND} candidate opening lines for a LinkedIn post, then score each one.

Article: ${item.title}
Source: ${item.source}
Content snippet: ${articleSnippet}
Post type: ${postType}
${ageRule ? `\nTEMPORAL RULE: ${ageRule}` : ''}

HARD CONSTRAINT: Each hook must be under 140 characters. This is the mobile "See More" truncation point — the full hook must be visible before the fold on all devices. If a hook exceeds 140 characters, score it 0 regardless of quality.

Rules for a strong hook (score 7-10):
- Under 140 characters (mandatory)
- Makes a specific, surprising, or tension-creating claim
- Drops the reader directly into the implication — does NOT restate the headline
- Uses a counterintuitive fact, a specific number/date, or a short declarative that creates tension
- Does NOT start with "I", "In [year]", or a rhetorical question
- Does NOT open with a definition

Rules for a weak hook (score 1-5):
- Over 140 characters
- Generic or restates the article headline
- Starts with "I followed by a bland statement"
- Opens with "In [year], ..." or a definition
- Asks a rhetorical question
- Violates the TEMPORAL RULE above

Return ONLY a valid JSON array (no markdown, no extra text):
[{"hook": "<opening line>", "score": <1-10>}, ...]`,
      }],
    });

    const rawText = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (!arrayMatch) continue;

    try {
      const hooks = JSON.parse(arrayMatch[0]) as Array<{ hook: string; score: number }>;
      for (const h of hooks) {
        // Hard reject hooks over 140 chars — mobile truncation limit
        if (h.hook.length > 140) continue;
        if (h.score > bestScore) {
          bestScore = h.score;
          bestHook = h.hook;
        }
      }
    } catch {
      continue;
    }

    if (bestScore >= HOOK_THRESHOLD) break;
  }

  console.log(`Best hook score: ${bestScore}/10`);
  return bestHook;
}

// Wraps verified company names in post text with [[MENTION:Name]] markers.
// Matches only whole-word occurrences; skips if already wrapped.
// Longer names are matched first to avoid partial replacements (e.g. "CNL" inside "Canadian Nuclear Laboratories").
function injectMentionMarkers(text: string): string {
  const verified = verifiedMentions();
  if (Object.keys(verified).length === 0) return text;

  // Sort by length descending so longer names match before shorter abbreviations
  const names = Object.keys(verified).sort((a, b) => b.length - a.length);
  let result = text;

  for (const name of names) {
    const marker = `[[MENTION:${name}]]`;
    // Skip if already marked (first occurrence already captured)
    if (result.includes(marker)) continue;
    // Replace only the first whole-word occurrence not preceded by #
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<!#)\\b${escaped}\\b`), marker);
  }

  return result;
}

// Computes hashtag performance from posted_history.json.
// Returns a ranked list of hashtags with avg engagement, sorted best-first.
// Only hashtags appearing in 2+ posts are eligible.
// Weighted composite performance score — inlined to avoid async import.
// Must stay in sync with SCORE_WEIGHTS in fetch-metrics.ts.
function compositeScore(m: any): number {
  if (!m) return 0;
  return (m.newFollowers ?? 0) * 10
       + (m.reposts ?? 0)      * 5
       + (m.sends ?? 0)        * 5
       + (m.comments ?? 0)     * 3
       + (m.saves ?? 0)        * 3
       + (m.reactions ?? 0)    * 1
       + (m.impressions ?? 0)  * 0.01;
}

function getHashtagPerformance(): Array<{ hashtag: string; posts: number; avgEngagement: number }> {
  if (!existsSync('posted_history.json')) return [];
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    const scores: Record<string, number[]> = {};
    for (const p of history) {
      if (!p.metrics) continue;
      const score = compositeScore(p.metrics);
      const content: string = p.finalContent ?? '';
      const hashtags = content.match(/#\w+/g) ?? [];
      for (const ht of hashtags) {
        const key = ht; // preserve original casing
        if (!scores[key]) scores[key] = [];
        scores[key].push(score);
      }
    }
    return Object.entries(scores)
      .filter(([, vals]) => vals.length >= 2)
      .map(([hashtag, vals]) => ({
        hashtag,
        posts: vals.length,
        avgEngagement: vals.reduce((a, b) => a + b, 0) / vals.length,
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);
  } catch {
    return [];
  }
}

export async function synthesizePost(item: FeedItem, postType: PostType): Promise<DraftPost> {
  const articleContent = item.fullText
    ? `Summary: ${item.summary}\n\nFull article text:\n${item.fullText}`
    : `Summary: ${item.summary}`;

  const ageDays = articleAgeDays(item.pubDate);
  const ageRule = ageLanguageRule(ageDays);

  console.log('Generating hooks...');
  const bestHook = await generateBestHook(item, postType);
  const hookConstraint = bestHook
    ? `\nOPENING LINE (use this exact sentence as your first line — do not alter it):\n${bestHook}\n`
    : '';

  // Build hashtag guidance from historical performance
  const hashtagPerf = getHashtagPerformance();
  let hashtagGuidance = '';
  if (hashtagPerf.length > 0) {
    const globalAvg = hashtagPerf.reduce((a, h) => a + h.avgEngagement, 0) / hashtagPerf.length;
    const above = hashtagPerf.filter(h => h.avgEngagement >= globalAvg);
    const below = hashtagPerf.filter(h => h.avgEngagement < globalAvg);

    const formatLine = (h: typeof hashtagPerf[0]) =>
      `${h.hashtag} (${h.posts} posts, avg ${h.avgEngagement.toFixed(1)} engagement)`;

    console.log(`Hashtag performance (avg ${globalAvg.toFixed(1)}): ${hashtagPerf.map(h => `${h.hashtag} ${h.avgEngagement.toFixed(1)}`).join(', ')}`);

    hashtagGuidance = `\nHASHTAG PERFORMANCE (from past posts — average engagement across all hashtags: ${globalAvg.toFixed(1)}):
${above.length > 0 ? `\nAbove average — prefer these when relevant:\n${above.map(formatLine).join('\n')}` : ''}
${below.length > 0 ? `\nBelow average — avoid unless the topic specifically demands them:\n${below.map(formatLine).join('\n')}` : ''}

When choosing hashtags, prefer high-performing ones from this list IF they are relevant to the post topic. Avoid below-average hashtags when a better-performing alternative exists for the same topic. Do not force irrelevant hashtags just because they performed well. Relevance always comes first.\n`;
  } else {
    console.log('Hashtag performance: no eligible hashtags yet (need 2+ posts each).');
  }

  const userPrompt = `NEWS ITEM:
Title: ${item.title}
Source: ${item.source}
Date: ${item.pubDate}
URL: ${item.link}
${articleContent}

POST TYPE: ${postType}
INSTRUCTION: ${POST_TYPE_INSTRUCTIONS[postType]}
${ageRule ? `TEMPORAL RULE: ${ageRule}\n` : ''}${hookConstraint}${hashtagGuidance}
Write the LinkedIn post now. You have the full article text above — use specific facts, figures, quotes, or details from it where they strengthen the post. Output only the post text — no preamble, no "here is your post," no quotation marks wrapping the whole thing.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let rawContent = message.content[0].type === 'text' ? message.content[0].text.trim() : '';

  // Fix a/an agreement (e.g. "A April" → "An April", "an project" → "a project")
  rawContent = rawContent
    .replace(/\bA ([AEIOUaeiou])/g, 'An $1')
    .replace(/\ban ([^AEIOUaeiouAEIOUaeiou\s])/g, 'a $1');

  // Word count enforcement: revise if < 80 or > 250 words
  const wordCount = rawContent.split(/\s+/).filter(Boolean).length;
  if (wordCount < 80 || wordCount > 250) {
    console.log(`Word count ${wordCount} — ${wordCount < 80 ? 'too short, expanding' : 'too long, trimming'}...`);
    const reviseMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `This LinkedIn post is ${wordCount} words, which is ${wordCount < 80 ? 'too short (minimum 80 words)' : 'too long (maximum 250 words)'}. Revise it to be between 130–200 words. Preserve the opening line, the key insight, and all hashtags. Output only the revised post — no preamble.\n\n${rawContent}`,
      }],
    });
    rawContent = reviseMsg.content[0].type === 'text' ? reviseMsg.content[0].text.trim() : rawContent;
  }

  const content = injectMentionMarkers(rawContent);

  // Generate first comment text only — URL is appended in code to avoid truncation
  const commentMessage = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:\n\n${content}\n\nWrite a first comment. Output the comment text only — do not include the URL.

${item.source && item.source !== 'Manual' ? `Format: Sourced from [Source Name]. [One simple question.]

Rules:
- "Sourced from [Source Name]" uses the publication name (e.g. "Sourced from World Nuclear News", "Sourced from Bruce Power", "Sourced from IAEA")
- Use a period after the source name, not a dash
- The question must be SHORT and SIMPLE — something a reader could answer in one sentence without thinking hard. Write it the way you'd casually ask a colleague, not how you'd phrase an exam question.
- Good examples: "Are you seeing this at your site?" / "Would this actually speed things up?" / "Has anyone tried this approach?"
- Bad examples: "Given the regulatory constraints of deterministic safety analysis frameworks, how might..." — too long, too academic, nobody wants to answer this
- One sentence only, under 20 words
- No em dashes
- No preamble, no sign-off, no URL

Source name: ${item.source}` : `Format: [One simple question.]

Rules:
- The question must be SHORT and SIMPLE — something a reader could answer in one sentence without thinking hard. Write it the way you'd casually ask a colleague.
- Good examples: "Are you seeing this at your site?" / "Would this actually speed things up?" / "Has anyone tried this approach?"
- One sentence only, under 20 words
- No em dashes
- No preamble, no sign-off, no URL`}`,
    }],
  });

  const commentText = commentMessage.content[0].type === 'text' ? commentMessage.content[0].text.trim() : '';
  const firstComment = item.link ? `${commentText}\n\n${item.link}` : commentText;

  return {
    content,
    firstComment,
    postType,
    sourceTitle: item.title,
    sourceUrl: item.link,
    sourceDate: item.pubDate,
    sourceFeed: item.source,
    generatedAt: new Date().toISOString(),
    imageUrl: item.imageUrl,
  };
}
