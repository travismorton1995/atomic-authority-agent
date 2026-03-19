import Anthropic from '@anthropic-ai/sdk';
import { DraftPost } from './synthesize.js';

const client = new Anthropic();

export interface ScreeningResult {
  cringeScore: number;
  reasoning: string;
  revisedContent: string | null;
  revisedFirstComment: string | null;
}

const SCREENER_SYSTEM = `You are a blunt editorial critic reviewing LinkedIn content for a professional in the nuclear/AI space.

Your job is to score the POST on a "Cringe Scale" from 1–10:
- 1–3: Clean. Reads like a real human who knows their field. No action needed.
- 4–6: Detectable AI polish. Some phrases feel generated. Needs tightening.
- 7–10: Heavy AI-isms. Would embarrass a senior engineer. Needs a rewrite.

CRINGE TRIGGERS (flag any of these):
- Phrases: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock potential," "seamlessly," "in today's landscape," "it's worth noting," "at the forefront"
- Structure: Starting with a rhetorical question as a hook, ending with "What do you think?" or a hollow call-to-action
- Tone: Breathless enthusiasm with no substance, vague optimism without a specific claim
- Missing: No industry-specific terminology (ALARA, SMR, CANDU, etc.), or the nuclear angle feels bolted on

HOOK QUALITY (evaluate the opening line specifically):
- A strong hook makes a specific, surprising, or tension-creating claim in the first sentence. It earns the scroll.
- A weak hook: starts with "I" followed by a generic statement, opens with "In [year]...", opens with a definition, or restates the article headline without adding a perspective.
- If the hook is weak, the cringe score should reflect it (bump by at least 2 points) and the revised version must open with a stronger line.
- Strong hook patterns: a counterintuitive fact, a specific number or date that signals something changed, a short declarative that creates tension, or dropping the reader directly into the implication of the news.

Also review the FIRST COMMENT separately. Apply the same cringe standards — it should sound like a natural follow-up thought from a real person, not a polished add-on. Always preserve the URL at the end unchanged.

FORMATTING RULE (applies to both post and comment): Never use em dashes (—). Replace with a comma, period, or rewrite the sentence.

Respond ONLY in this exact JSON format:
{
  "cringeScore": <number 1-10>,
  "reasoning": "<one or two sentences explaining the score, calling out hook quality specifically if it is weak>",
  "revisedContent": <null if score <= 3, otherwise a rewritten version of the post as a string>,
  "revisedFirstComment": <null if the comment is clean, otherwise a revised version preserving the URL at the end>
}`;

export async function screenPost(draft: DraftPost): Promise<ScreeningResult> {
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    system: SCREENER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Review this LinkedIn post and its first comment.\n\nPOST:\n${draft.content}\n\nFIRST COMMENT:\n${draft.firstComment}`,
    }],
  });

  const rawText = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const raw = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const result = JSON.parse(raw) as ScreeningResult;
    return result;
  } catch {
    console.error('Screener returned non-JSON response:', raw);
    return { cringeScore: 0, reasoning: 'Screener parse error', revisedContent: null, revisedFirstComment: null };
  }
}
