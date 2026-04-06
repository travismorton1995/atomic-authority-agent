import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './persona.js';

const client = new Anthropic();

export type CommentType = 'question' | 'agreement' | 'pushback' | 'adds-context' | 'generic';

export interface ReplyOption {
  label: string;  // e.g. "push-back", "add-context", "direct"
  text: string;   // the actual reply text to post
}

export interface GeneratedReplies {
  commentType: CommentType;
  reasoning: string;
  recommendationReason: string;   // 1-liner why the top option is suggested
  options: [ReplyOption, ReplyOption, ReplyOption]; // recommended is always index 0
}

const REPLY_APPROACHES = `
- agree: Affirm a specific point they made and add something new they didn't say
- push-back: Challenge their claim directly with a concrete counter-argument or different framing
- add-context: Bring in a specific detail, stat, or angle they didn't consider that changes the picture
- question: Respond with a single pointed question that advances the discussion — genuinely curious or probing, not rhetorical
- concede: Acknowledge what's valid in their critique, hold your ground on the rest
- reframe: Accept their facts but reframe what they mean — different conclusion from the same premise
- direct: The shortest, plainest response — no setup, no hedging, just the core claim
`.trim();

const ANTI_AI_RULES = `
Hard constraints — any violation is a rewrite trigger:
- Never use: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock," "seamlessly," "it's worth noting," "this matters because," "at its core," or similar AI-ism phrases
- Never use contrasting reframe sentences. Banned: "It's not X, it's Y" / "This isn't about X, it's about Y" / "Not X. Y." / "Less X, more Y." / "Not just X — Y." Make the actual claim directly.
- No em dashes (—). Use a comma or period instead.
- No gerund openers ("Building on this...", "Recognizing the need...")
- No pivot fillers ("But here's the thing." / "Here's what that means.")
- No hollow openers: "Great question", "Thanks for", "Interesting point", or starting with "I"
- No validation phrases: "what you are describing is real", "this is spot on", "you nailed it"
- No stacked adjectives before nouns
`.trim();

const RECOMMENDATION_CRITERIA = `
For "recommended" — pick the index (0, 1, or 2) of the best option using these criteria in order:
1. Address the commenter respectfully and keep the conversation flowing — prefer options that invite a response over those that close the thread
2. Steer toward the main premise of the post if the comment has drifted from it
3. Stick to claims supported by the source article — prefer specific, verifiable facts over editorializing
4. Recommend disagreement (push-back, reframe) only if the commenter is clearly off-base or off-topic; otherwise prefer options that build on or extend the exchange
5. Stay professional — never sharp or dismissive unless the comment is obtuse or bad-faith
`.trim();

export async function screenReply(text: string): Promise<string> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You are a strict copy editor for a professional LinkedIn comment. Check this reply for AI-ism phrases, contrasting reframe patterns, em dashes, gerund openers, and hollow openers. If clean, return it unchanged. If not, rewrite it minimally to fix only the violations — preserve the meaning and length.

REPLY:
"${text}"

${ANTI_AI_RULES}

Return ONLY the final reply text — no quotes, no explanation, no preamble.`,
    }],
  });
  const result = message.content[0].type === 'text' ? message.content[0].text.trim() : text;
  // Strip surrounding quotes if the model added them
  return result.replace(/^["']|["']$/g, '');
}

export async function generateReplies(
  post: { content: string; postType: string; articleTitle?: string },
  comment: { author: string; text: string },
  thread: Array<{ author: string; text: string }> = [],
): Promise<GeneratedReplies> {
  const threadSection = thread.length > 0
    ? `\nOTHER COMMENTS IN THIS THREAD (for context only):\n${thread.map(c => `${c.author}: "${c.text.slice(0, 150)}"`).join('\n')}\n`
    : '';

  const articleSection = post.articleTitle
    ? `\nSource article: "${post.articleTitle}"\n`
    : '';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:
${post.content}
${articleSection}${threadSection}
${comment.author} commented:
"${comment.text}"

Do three things and return a single JSON object:

1. CLASSIFY the comment as one of: question | agreement | pushback | adds-context | generic

2. REASON about the comment in 2-3 sentences: What is the commenter's intent? How are they engaging with the post or other commenters? What do they want from this exchange?

3. GENERATE 3 reply options that each take a DIFFERENT conversational approach. Choose the 3 most fitting from this list:
${REPLY_APPROACHES}

Each reply must:
- Be 1 sentence. 2 short sentences only if genuinely necessary.
- Address the commenter directly — never refer to them in third person ("the commenter", "their point", "their skepticism")
- Draw on thread context and the source article where relevant — prefer verifiable facts over editorializing
- Sound like the post author — same technical voice, direct, grounded

${ANTI_AI_RULES}

4. RECOMMEND one option index using these criteria:
${RECOMMENDATION_CRITERIA}

Return ONLY valid JSON — no markdown, no extra text:
{
  "commentType": "<type>",
  "reasoning": "<2-3 sentence analysis>",
  "recommended": <0|1|2>,
  "recommendationReason": "<one sentence: why this option is best for this specific comment and context>",
  "options": [
    { "label": "<approach>", "text": "<reply>" },
    { "label": "<approach>", "text": "<reply>" },
    { "label": "<approach>", "text": "<reply>" }
  ]
}`,
    }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('Reply generator returned no JSON object');

  const parsed = JSON.parse(objMatch[0]) as {
    commentType: string;
    reasoning: string;
    recommended?: number;
    recommendationReason?: string;
    options: Array<{ label: string; text: string }>;
  };

  if (!parsed.options || parsed.options.length < 3) {
    throw new Error(`Expected 3 reply options, got ${parsed.options?.length ?? 0}`);
  }

  // Reorder so recommended option is always first
  const recommendedIdx = [0, 1, 2].includes(parsed.recommended ?? -1) ? (parsed.recommended as number) : 0;
  const orderedOptions = [
    parsed.options[recommendedIdx],
    ...parsed.options.filter((_, i) => i !== recommendedIdx),
  ].slice(0, 3);

  // Screen each option for AIisms — verify step is skipped for replies (1-sentence replies
  // have no stats/dates to check, and using the post as a proxy article confuses the verifier)
  const cleaned = await Promise.all(
    orderedOptions.map(async (opt) => {
      const afterScreen = await screenReply(opt.text);
      if (afterScreen !== opt.text) {
        console.log(`    [screen] revised AIisms in "${opt.label}" option`);
      }
      return { label: opt.label, text: afterScreen };
    }),
  );

  const validTypes: CommentType[] = ['question', 'agreement', 'pushback', 'adds-context', 'generic'];
  const commentType: CommentType = validTypes.includes(parsed.commentType as CommentType)
    ? (parsed.commentType as CommentType)
    : 'generic';

  return {
    commentType,
    reasoning: parsed.reasoning ?? '',
    recommendationReason: parsed.recommendationReason ?? '',
    options: [
      { label: cleaned[0].label, text: cleaned[0].text },
      { label: cleaned[1].label, text: cleaned[1].text },
      { label: cleaned[2].label, text: cleaned[2].text },
    ],
  };
}
