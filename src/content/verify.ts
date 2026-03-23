import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export interface VerificationResult {
  correctedContent: string;
  flaggedClaims: string[];
  changed: boolean;
}

export async function verifyPost(content: string, articleText: string): Promise<VerificationResult> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a fact-checker. A LinkedIn post was written based on an article. Check whether any specific factual claims in the post are unsupported or contradicted by the article.

LINKEDIN POST:
${content}

SOURCE ARTICLE:
${articleText.split(/\s+/).slice(0, 1500).join(' ')}

Check for:
- Specific statistics or percentages (e.g. "40% of reactors", "$2B investment")
- Specific dates or timelines
- Quotes or attributed statements
- Specific decisions, approvals, or events claimed as fact

Rules:
- Only flag a claim if it is clearly wrong or directly contradicted by the article. Do NOT flag plausible inferences, paraphrases, or editorial framing.
- If a specific number in the post differs from the article (e.g. "10" vs "12"), correct it to match the article.
- If a claim is not in the article but is plausible and not contradicted, leave it alone.
- If the post is factually sound, return it unchanged.

Respond ONLY with this exact JSON format:
{
  "correctedContent": "<the post text with any corrections applied, or original if no corrections needed>",
  "flaggedClaims": ["<description of change made>", ...]
}`,
    }],
  });

  const rawText = message.content[0].type === 'text' ? message.content[0].text.trim() : '';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    console.warn('Verifier returned non-JSON response — skipping verification.');
    return { correctedContent: content, flaggedClaims: [], changed: false };
  }

  try {
    const result = JSON.parse(jsonMatch[0]) as { correctedContent: string; flaggedClaims: string[] };
    const changed = result.correctedContent.trim() !== content.trim() && result.flaggedClaims.length > 0;
    return {
      correctedContent: result.correctedContent || content,
      flaggedClaims: result.flaggedClaims ?? [],
      changed,
    };
  } catch {
    console.warn('Verifier JSON parse error — skipping verification.');
    return { correctedContent: content, flaggedClaims: [], changed: false };
  }
}
