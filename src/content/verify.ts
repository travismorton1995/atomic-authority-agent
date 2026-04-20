import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export interface VerificationResult {
  correctedContent: string;
  flaggedClaims: string[];
  changed: boolean;
}

export async function verifyPost(content: string, articleText: string): Promise<VerificationResult> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a rigorous fact-checker for a professional LinkedIn post. A post was written based on a source article. Your job is to ensure every factual claim in the post is supported by the article.

LINKEDIN POST:
${content}

SOURCE ARTICLE:
${articleText.split(/\s+/).slice(0, 2500).join(' ')}

STEP 1 — EXTRACT CLAIMS
List every specific factual claim in the post. A claim is any statement that could be true or false:
- Numbers, statistics, percentages, dollar amounts
- Dates, timelines, deadlines
- Named entities (people, organizations, locations) and what is said about them
- Cause-and-effect statements presented as fact
- Characterizations of decisions, policies, or events

STEP 2 — CHECK EACH CLAIM
For each claim, determine:
- SUPPORTED: The article contains this information or directly implies it
- UNSUPPORTED: The article does not mention this — the post author may have fabricated it
- CONTRADICTED: The article says something different
- PLAUSIBLE INFERENCE: Not stated directly but a reasonable reading of the article

STEP 3 — CORRECT
- Fix any CONTRADICTED claims to match the article exactly
- Remove or soften any UNSUPPORTED claims that present specific facts (numbers, names, dates). Replace with vaguer language that doesn't assert unverified specifics.
- Leave SUPPORTED and PLAUSIBLE INFERENCE claims unchanged
- Preserve the post's tone, structure, and length as closely as possible

Respond ONLY with this exact JSON format:
{
  "claims": [
    { "claim": "<the specific claim>", "status": "supported|unsupported|contradicted|plausible", "note": "<brief explanation>" }
  ],
  "correctedContent": "<the post text with any corrections applied, or original if no corrections needed>",
  "flaggedClaims": ["<description of each change made>"]
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
    const result = JSON.parse(jsonMatch[0]) as {
      claims?: Array<{ claim: string; status: string; note: string }>;
      correctedContent: string;
      flaggedClaims: string[];
    };

    // Log the claim analysis for visibility
    if (result.claims && result.claims.length > 0) {
      const supported = result.claims.filter(c => c.status === 'supported').length;
      const unsupported = result.claims.filter(c => c.status === 'unsupported').length;
      const contradicted = result.claims.filter(c => c.status === 'contradicted').length;
      const plausible = result.claims.filter(c => c.status === 'plausible').length;
      console.log(`  Claims: ${supported} supported, ${plausible} plausible, ${unsupported} unsupported, ${contradicted} contradicted`);

      for (const c of result.claims) {
        if (c.status === 'unsupported' || c.status === 'contradicted') {
          console.log(`    ⚠ [${c.status}] ${c.claim}`);
          if (c.note) console.log(`      ${c.note}`);
        }
      }
    }

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
