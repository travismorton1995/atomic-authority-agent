import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export interface CommentOption {
  label: string;
  text: string;
}

export interface GeneratedComment {
  reasoning: string;
  recommendationReason: string;
  options: [CommentOption, CommentOption];   // index 0 is always recommended
}

const OUTBOUND_APPROACHES = `
- add-context: Bring in a specific fact, stat, or angle they didn't mention that deepens the picture
- ask-question: A single pointed question — genuinely curious or probing, advances the discussion
- counterpoint: Challenge a specific claim directly with a concrete counter-argument or different framing
- affirm-extend: Agree with their core point and add one concrete thing they didn't say
`.trim();

const ANTI_AI_RULES = `
Hard constraints — any violation is a rewrite trigger:
- Never use: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock," "seamlessly," "it's worth noting," "this matters because," "at its core," or similar AI-ism phrases
- Never use contrasting reframe sentences. Banned: "It's not X, it's Y" / "This isn't about X, it's about Y" / "Not X. Y." / "Less X, more Y." / "Not just X — Y."
- No em dashes (—). Use a comma or period instead.
- No gerund openers ("Building on this...", "Recognizing the need...")
- No pivot fillers ("But here's the thing." / "Here's what that means.")
- No hollow openers: "Great post", "Thanks for sharing", "Interesting point", or starting with "I"
- No stacked adjectives before nouns
- Never reference your own posts, content, or experience directly
- Never be self-promotional
`.trim();

export async function generateOutboundComment(
  post: { text: string; authorName: string; url: string },
): Promise<GeneratedComment> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are Travis Morton, MEng — an AI developer working at the intersection of AI and the nuclear industry. You are adding a comment to someone else's LinkedIn post as a knowledgeable peer.

${post.authorName} posted:
"${post.text.slice(0, 800)}"

Do three things and return a single JSON object:

1. REASON in 1-2 sentences: What is the core claim or question in this post? What angle can you add as a nuclear/AI practitioner that would be genuinely useful to the author and their readers?

2. GENERATE 2 comment options using different approaches from:
${OUTBOUND_APPROACHES}

Each comment must:
- Be exactly 1 sentence. No exceptions.
- Add genuine value — a specific fact, a pointed question, or a concrete counter-argument
- Sound like a thoughtful industry peer joining the conversation, not the post author
- Draw on nuclear/AI domain knowledge where relevant

${ANTI_AI_RULES}

3. RECOMMEND one option (0 or 1) that best invites engagement back from the author or their audience, and give a 1-sentence reason.

Return ONLY valid JSON:
{
  "reasoning": "<1-2 sentence analysis>",
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

  return {
    reasoning: parsed.reasoning ?? '',
    recommendationReason: parsed.recommendationReason ?? '',
    options: [
      { label: ordered[0].label, text: ordered[0].text },
      { label: ordered[1].label, text: ordered[1].text },
    ],
  };
}
