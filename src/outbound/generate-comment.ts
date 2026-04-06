import Anthropic from '@anthropic-ai/sdk';
import { screenReply } from '../content/reply.js';

const client = new Anthropic();

export interface CommentOption {
  label: string;
  text: string;
}

export interface GeneratedComment {
  postSummary: string;
  reasoning: string;
  recommendationReason: string;
  options: [CommentOption, CommentOption];   // index 0 is always recommended
}

const OUTBOUND_APPROACHES = `
DEFAULT approaches (use these in most cases):
- affirm-extend: Agree with their core point and add one concrete thing they didn't say
- add-context: Bring in an angle, implication, or connection they didn't mention that deepens the picture
- support: Back up their argument with a related observation or experience that reinforces their point

ONLY use these if the post makes a controversial, outlandish, or very niche claim:
- ask-question: A single pointed question — genuinely curious, not combative
- counterpoint: Challenge a specific claim directly with a concrete counter-argument or different framing
`.trim();

const ANTI_AI_RULES = `
Hard constraints — any violation is a rewrite trigger:
- Never use: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock," "seamlessly," "it's worth noting," "this matters because," "at its core," "the [X] I keep hearing," "let me steelman that," or similar AI-ism phrases
- Never use contrasting reframe sentences. Banned: "It's not X, it's Y" / "This isn't about X, it's about Y" / "Not X. Y." / "Less X, more Y." / "Not just X — Y."
- No em dashes (—). Use a comma or period instead.
- No gerund openers ("Building on this...", "Recognizing the need...")
- No pivot fillers ("But here's the thing." / "Here's what that means.")
- No hollow openers: "Great post", "Thanks for sharing", "Interesting point", or starting with "I"
- No validation phrases: "what you are describing is real", "this is spot on", "you nailed it"
- No stacked adjectives before nouns
- Never reference your own posts, content, or experience directly
- Never be self-promotional
`.trim();

export async function generateOutboundComment(
  post: { text: string; authorName: string; url: string },
  options: { insider?: boolean; colleague?: boolean; stranger?: boolean } = {},
): Promise<GeneratedComment> {
  const insiderContext = options.insider
    ? `You work at ${post.authorName}. Comment as an insider — you can speak with direct knowledge of the work, acknowledge being part of the team, and add context that only someone internal would know. Still add genuine value; don't just cheer.`
    : `You are commenting as an external peer — a knowledgeable outsider adding perspective, not an employee.`;

  const colleagueContext = options.colleague
    ? `This person is a direct colleague. Do not use contrarian, counterpoint, or push-back approaches. Stick to add-context, ask-question, or affirm-extend only.`
    : '';

  const strangerContext = options.stranger
    ? `You do not know this person. This post was found via a hashtag feed. Keep the tone respectful and constructive. Prefer ask-question or add-context approaches over counterpoint. Your goal is to start a genuine conversation, not to challenge a stranger.`
    : '';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are Travis Morton, MEng — an AI developer working at the intersection of AI and the nuclear industry. You are adding a comment to a LinkedIn post.

${insiderContext}${colleagueContext ? `\n${colleagueContext}` : ''}${strangerContext ? `\n${strangerContext}` : ''}

${post.authorName} posted:
"${post.text.slice(0, 800)}"

Do four things and return a single JSON object:

1. SUMMARIZE the post in exactly 1 plain-English sentence — what is it actually saying? No jargon.

2. REASON in exactly 1 sentence: What specific angle can you add that would be genuinely useful?

3. GENERATE 2 comment options using different approaches from:
${OUTBOUND_APPROACHES}

IMPORTANT: Default to supportive approaches (affirm-extend, add-context, support). Only use ask-question or counterpoint if the post is making a genuinely controversial, outlandish, or highly debatable claim. Most LinkedIn posts deserve agreement and added value, not challenge.

Each comment must:
- Be exactly 1 sentence. No exceptions.
- Add genuine value — a supporting observation, additional context, or a reframing that builds on the post
- Never cite specific numbers, stats, dates, or named studies unless they appear in the original post. Your knowledge may be wrong. Use reasoning, analogy, or experience-based framing instead.
- Write for a general professional audience — assume the reader is smart but not a specialist. Plain words over technical ones. If a concept needs jargon to express, find the plain-English version instead.
- Competence comes through the sharpness of the insight, not the vocabulary

${ANTI_AI_RULES}

4. RECOMMEND one option (0 or 1) that best invites engagement back from the author or their audience, and give a 1-sentence reason.

Return ONLY valid JSON:
{
  "postSummary": "<1 sentence plain English summary>",
  "reasoning": "<1 sentence angle>",
  "recommended": <0|1>,
  "recommendationReason": "<one sentence why>",
  "options": [
    { "label": "<approach>", "text": "<comment>" },
    { "label": "<approach>", "text": "<comment>" }
  ]
}`,
    }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('Comment generator returned no JSON');

  const parsed = JSON.parse(objMatch[0]) as {
    postSummary?: string;
    reasoning: string;
    recommended?: number;
    recommendationReason?: string;
    options: Array<{ label: string; text: string }>;
  };

  if (!parsed.options || parsed.options.length < 2) {
    throw new Error(`Expected 2 comment options, got ${parsed.options?.length ?? 0}`);
  }

  // Reorder so recommended is always index 0
  const recIdx = [0, 1].includes(parsed.recommended ?? -1) ? (parsed.recommended as number) : 0;
  const ordered = recIdx === 0
    ? [parsed.options[0], parsed.options[1]]
    : [parsed.options[1], parsed.options[0]];

  // Screen each option for AIisms
  const screened = await Promise.all(
    ordered.map(async (opt) => {
      const text = await screenReply(opt.text);
      if (text !== opt.text) console.log(`    [screen] revised AIisms in "${opt.label}" option`);
      return { label: opt.label, text };
    }),
  );

  return {
    postSummary: parsed.postSummary ?? '',
    reasoning: parsed.reasoning ?? '',
    recommendationReason: parsed.recommendationReason ?? '',
    options: [
      { label: screened[0].label, text: screened[0].text },
      { label: screened[1].label, text: screened[1].text },
    ],
  };
}
