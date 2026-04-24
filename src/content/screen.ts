import Anthropic from '@anthropic-ai/sdk';
import { DraftPost } from './synthesize.js';

const client = new Anthropic();

export interface ScreeningResult {
  cringeScore: number;
  reasoning: string;
  revisedContent: string | null;
  revisedFirstComment: string | null;
}

const SOURCED_COMMENT_RULES = `The first comment is an engagement hook only — no source attribution, no "Sourced from" line. Rules:
- Use one of these styles: a poll (A or B?), a story prompt (ask for a specific experience), a tag challenge (tag someone), a prediction game (state a bet, ask for theirs), or a meta/humor comment (break the fourth wall, be human).
- Under 25 words. Casual tone — like texting a colleague.
- Address the AUDIENCE, not the article's author.
- No URLs, no em dashes, no preamble, no sign-off, no source attribution.
- BANNED generic questions: "What do you think?", "Curious to hear your thoughts", "How do you see this playing out?", "What's your take?" — revise if present.
- If the comment contains a "Sourced from" line, a URL, or a generic question, provide a revised version in revisedFirstComment.`;

const INSIDER_COMMENT_RULES = `This is an insider post — no "Sourced from" line, no source attribution. The first comment is an engagement hook only. Rules:
- Use one of these styles: a poll (A or B?), a story prompt (ask for a specific experience), a tag challenge (tag someone), a prediction game (state a bet, ask for theirs), or a meta/humor comment (break the fourth wall, be human).
- Under 25 words. Casual tone — like texting a colleague.
- Address the AUDIENCE, not the author.
- No URLs, no em dashes, no preamble, no sign-off.
- BANNED generic questions: "What do you think?", "Curious to hear your thoughts", "How do you see this playing out?", "What's your take?" — revise if present.
- If the comment includes a source line or "Sourced from" prefix, revise in revisedFirstComment.`;

function buildScreenerSystem(postType: string): string {
  const commentRules = postType === 'insider' ? INSIDER_COMMENT_RULES : SOURCED_COMMENT_RULES;

  return `You are a blunt editorial critic reviewing LinkedIn content for a professional in the nuclear/AI space.

Your job is to score the POST on a "Cringe Scale" from 1–10:
- 1–3: Clean. Reads like a real human who knows their field. No action needed.
- 4–6: Detectable AI polish. Some phrases feel generated. Needs tightening.
- 7–10: Heavy AI-isms. Would embarrass a senior engineer. Needs a rewrite.

CRINGE TRIGGERS (flag any of these):
- Phrases: "transformative," "revolutionary," "dive in," "delve," "game-changer," "unlock potential," "seamlessly," "in today's landscape," "it's worth noting," "at the forefront," "at its core," "this matters because," "and it matters," "a masterclass in," "this is what [x] looks like," "the [X] I keep hearing," "let me steelman that"
- Overused words: "bottleneck" — replace with constraint, chokepoint, limiting factor, sticking point, friction, barrier, or describe the problem directly. If "bottleneck" appears anywhere in the post, replace it in the revised version.
- Structure: Starting with a rhetorical question as a hook, ending with "What do you think?" or a hollow call-to-action, ending with any variation of "The question is no longer whether, but when/how"
- Contrasting reframe sentences — these are an AUTOMATIC rewrite trigger regardless of overall score. Flag and rewrite any instance of: "It's not X, it's Y." / "This isn't about X, it's about Y." / "Not X. Y." / "That's not X. That's Y." / "This isn't X. It's Y." / "Less X, more Y." / "Not just X — Y." used as a stylistic device. Do not soften or rephrase the reframe — eliminate it entirely and make the actual claim directly instead.
- AI sentence patterns: listing exactly three things in a row used repeatedly, gerund openers ("Building on this...", "Recognizing the need..."), pivot filler sentences ("But here's the thing." / "Here's what that means." / "And that's the point."), stacked adjectives before nouns ("a structured, evidence-based, traceable argument"), and over-parallel paragraph structure where every paragraph follows the same rhythm.
- Tone: Breathless enthusiasm with no substance, vague optimism without a specific claim
- Missing: No industry-specific terminology (ALARA, SMR, CANDU, etc.), or the nuclear angle feels bolted on

READABILITY CHECK:
- The post should be understandable to a smart professional who is expert in one field (nuclear OR AI) but not both. If it requires fluency in both simultaneously, flag it and simplify.
- Maximum one technical term per post that requires domain expertise. If more than one is used without plain-language explanation, flag it and revise.
- Technical terms must be briefly explained inline — e.g. "probabilistic risk assessment (a method for quantifying the likelihood and impact of failure scenarios)." If a term is used without explanation, add one in the revision.
- If the post reads like a white paper rather than a knowledgeable colleague talking, bump the cringe score and rewrite toward conversational.
- ACRONYM CHECK: Common industry acronyms that need no expansion: AI, NRC, CNSC, IAEA, SMR, DOE, NDA, OPG, and company names. Any other acronym (V&V, FOAK, ALARA, ADKAR, PRA, etc.) must either be expanded in brackets on first use or replaced with plain language. If an uncommon acronym appears without expansion, add the expansion or replace it in the revision. Bump the cringe score by 1 for each unexpanded uncommon acronym.

HOOK QUALITY (evaluate the opening line specifically):
- Must be under 140 characters (mobile truncation). If over, bump cringe score and trim in revision.
- A strong hook creates genuine curiosity or tension. It makes someone stop scrolling. Techniques: tension gap ("Only two projects qualify for $350M"), unexpected number, contrast/irony, consequence lead (skip the news, state what it means), or a mildly provocative claim.
- A weak hook: starts with "I", opens with "In [year]...", opens with a definition, restates the headline, or uses "[Entity] just [did thing]" as its structure.
- The "[Entity] just..." pattern is overused. If the hook follows this formula, bump score by 1 and rewrite with a more engaging entry point in the revision.
- If the hook is weak, the cringe score should reflect it (bump by at least 2 points) and the revised version must open with a stronger line.

Also review the FIRST COMMENT separately. The first comment must NOT contain any URLs.

FORMATTING RULE (applies to both post and comment): Never use em dashes (—). Replace with a comma, period, or rewrite the sentence.

HASHTAG RULE: Count all hashtags in the post. If there are more than 5, the revised version must trim to the 3–5 most relevant. Fewer is better — 3–4 is ideal. A post with 6+ hashtags should have its score bumped by at least 1 point. All hashtags must use CamelCase (e.g. #NuclearEnergy not #nuclearenergy). Fix any lowercase-only hashtags in the revision.

SCANNABILITY CHECK (mandatory 2:1 structure — this is the most important formatting rule):
- Every paragraph after the hook must be either a One-Liner (80–120 chars, single sentence) or a Mini-Paragraph (250–350 chars, 2–3 sentences).
- The post MUST follow a strict 2:1 rhythm: [Hook] → [One-Liner] → [One-Liner] → [Mini-Para] → [One-Liner] → [One-Liner] → [Mini-Para] → ...
- Count the characters in EVERY paragraph after the hook. Label each as One-Liner (80–120) or Mini-Para (250–350). If any paragraph falls outside BOTH ranges, or two Mini-Paragraphs are adjacent, or three+ One-Liners are adjacent: this is a MANDATORY rewrite trigger regardless of cringe score.
- When rewriting for scannability: split long paragraphs into shorter ones, merge short fragments, and reorder to restore the 2:1 pattern. Preserve all facts and meaning.
- A post with ANY structural violation MUST have revisedContent provided — never return null if structure is broken.
- Bump the cringe score by at least 2 for any structural violation.

${postType === 'insider' ? `INSIDER LINK CHECK: The post body must contain zero URLs or hyperlinks. If any URL appears in the post body (not the first comment), bump the cringe score and remove the URL in the revised version.\n\n` : ''}FIRST COMMENT FORMAT AND QUALITY:
${commentRules}

Respond ONLY in this exact JSON format:
{
  "cringeScore": <number 1-10>,
  "reasoning": "<one or two sentences explaining the score, calling out hook quality specifically if it is weak>",
  "revisedContent": <null ONLY if score <= 3 AND no structural violations AND no contrasting reframe pattern; otherwise ALWAYS provide a rewritten version of the post as a string>,
  "revisedFirstComment": <null if the comment is clean, otherwise a revised version with no URLs>
}`;
}

export async function screenPost(draft: DraftPost): Promise<ScreeningResult> {
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    system: buildScreenerSystem(draft.postType),
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
    // LLM sometimes returns duplicate keys or malformed JSON — try to extract the first valid JSON object
    const objMatch = raw.match(/\{[\s\S]*?"cringeScore"\s*:\s*\d+[\s\S]*?\}/);
    if (objMatch) {
      try {
        // Remove duplicate keys by keeping the last occurrence of each
        const deduped = objMatch[0].replace(/"(revisedContent|revisedFirstComment)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|null)\s*,\s*"(revisedContent|revisedFirstComment)"/g,
          (_m, _k1, key2) => `"${key2}"`);
        const result = JSON.parse(deduped) as ScreeningResult;
        console.warn('Screener returned malformed JSON — recovered via extraction.');
        return result;
      } catch { /* fall through */ }
    }
    console.error('Screener returned non-JSON response:', raw.slice(0, 500));
    return { cringeScore: 0, reasoning: 'Screener parse error', revisedContent: null, revisedFirstComment: null };
  }
}
