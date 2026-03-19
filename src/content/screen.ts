import Anthropic from '@anthropic-ai/sdk';
import { DraftPost } from './synthesize.js';

const client = new Anthropic();

export interface ScreeningResult {
  cringeScore: number;
  reasoning: string;
  revisedContent: string | null;
}

const SCREENER_SYSTEM = `You are a blunt editorial critic reviewing LinkedIn posts for a professional in the nuclear/AI space.

Your job is to score the post on a "Cringe Scale" from 1–10:
- 1–3: Clean. Reads like a real human who knows their field. No action needed.
- 4–6: Detectable AI polish. Some phrases feel generated. Needs tightening.
- 7–10: Heavy AI-isms. Would embarrass a senior engineer. Needs a rewrite.

CRINGE TRIGGERS (flag any of these):
- Phrases: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock potential," "seamlessly," "in today's landscape," "it's worth noting," "at the forefront"
- Structure: Starting with a rhetorical question as a hook, ending with "What do you think?" or a hollow call-to-action
- Tone: Breathless enthusiasm with no substance, vague optimism without a specific claim
- Missing: No industry-specific terminology (ALARA, SMR, CANDU, etc.), or the nuclear angle feels bolted on

Respond ONLY in this exact JSON format:
{
  "cringeScore": <number 1-10>,
  "reasoning": "<one or two sentences explaining the score>",
  "revisedContent": <null if score <= 3, otherwise a rewritten version of the post as a string>
}`;

export async function screenPost(draft: DraftPost): Promise<ScreeningResult> {
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 800,
    system: SCREENER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Review this LinkedIn post:\n\n${draft.content}`,
    }],
  });

  const rawText = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const raw = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const result = JSON.parse(raw) as ScreeningResult;
    return result;
  } catch {
    console.error('Screener returned non-JSON response:', raw);
    return { cringeScore: 0, reasoning: 'Screener parse error', revisedContent: null };
  }
}
