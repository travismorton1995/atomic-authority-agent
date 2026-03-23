import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';
import { PostType, SYSTEM_PROMPT, POST_TYPE_INSTRUCTIONS } from './persona.js';

const client = new Anthropic();

export interface DraftPost {
  content: string;
  firstComment: string;
  postType: PostType;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  generatedAt: string;
}

const HOOK_THRESHOLD = 7;
const HOOKS_PER_ROUND = 3;
const MAX_HOOK_ROUNDS = 2;

function articleAgeDays(pubDate: string): number | null {
  if (!pubDate) return null;
  const ms = Date.now() - new Date(pubDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
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

Rules for a strong hook (score 7-10):
- Makes a specific, surprising, or tension-creating claim
- Drops the reader directly into the implication — does NOT restate the headline
- Uses a counterintuitive fact, a specific number/date, or a short declarative that creates tension
- Does NOT start with "I", "In [year]", or a rhetorical question
- Does NOT open with a definition

Rules for a weak hook (score 1-5):
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

  const userPrompt = `NEWS ITEM:
Title: ${item.title}
Source: ${item.source}
Date: ${item.pubDate}
URL: ${item.link}
${articleContent}

POST TYPE: ${postType}
INSTRUCTION: ${POST_TYPE_INSTRUCTIONS[postType]}
${ageRule ? `TEMPORAL RULE: ${ageRule}\n` : ''}${hookConstraint}
Write the LinkedIn post now. You have the full article text above — use specific facts, figures, quotes, or details from it where they strengthen the post. Output only the post text — no preamble, no "here is your post," no quotation marks wrapping the whole thing.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0].type === 'text' ? message.content[0].text.trim() : '';

  // Generate first comment: follow-up thought + engagement question + source URL
  const commentMessage = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:\n\n${content}\n\nWrite a first comment in this exact format — nothing else, no preamble, no sign-off:

1. One sentence of genuine follow-up thought that adds a specific angle or detail not in the post.
2. One direct question to invite practitioners to reply (e.g. "What's your experience with X in practice?" or "Has your org tackled this yet?"). The question must be specific — not "What do you think?" or "Thoughts?".
3. The source URL on its own line.

Format:
<follow-up sentence>

<engagement question>

${item.link}`,
    }],
  });

  const firstComment = commentMessage.content[0].type === 'text' ? commentMessage.content[0].text.trim() : item.link;

  return {
    content,
    firstComment,
    postType,
    sourceTitle: item.title,
    sourceUrl: item.link,
    sourceDate: item.pubDate,
    generatedAt: new Date().toISOString(),
  };
}
