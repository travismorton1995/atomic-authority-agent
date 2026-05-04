// Standalone comment generation functions for Pipeline V2.
// Extracted from synthesize.ts so they can be called independently.

import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';

const client = new Anthropic();

/** Generate a first comment for a published post. */
export async function synthesizeFirstComment(postContent: string): Promise<string> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:\n\n${postContent}\n\nWrite a first comment designed to get people to reply. Output the comment text only.

FORMAT — engagement hook only, no source attribution:

COMMENT STYLES — rotate between these. Pick whichever fits the post best:

1. THE POLL — Give two clear options and ask which one. "Option A or Option B? I'm leaning A."
   Example: "SMRs on the grid by 2030 or 2035? I'll take the over."

2. THE STORY PROMPT — Ask for a specific experience. Make it easy to answer with one sentence.
   Example: "What's the most surprising pushback you've gotten on a nuclear project?"

3. THE TAG CHALLENGE — Ask readers to tag someone relevant.
   Example: "Tag an engineer who's dealt with this exact licensing headache."

4. THE PREDICTION GAME — State your bet and ask for theirs.
   Example: "I give it 18 months. What's your number?"

5. THE META / HUMOR — Break the fourth wall. Be human. Make someone smile.
   Examples: "Does anyone even read these first comments?" / "I wrote this post three times before it stopped sounding like a press release." / "If you made it this far, you're my people."

RULES:
- Under 25 words for the engagement hook (not counting the source line)
- Be casual and human — write like you're texting a colleague, not moderating a panel
- No em dashes
- No preamble, no sign-off, no URL
- Address the AUDIENCE, never the article's author
- BANNED: "What do you think?", "Curious to hear your thoughts", "How do you see this playing out?", "What's your take?" — these are generic and get zero engagement`,
    }],
  });

  return msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
}

/** Generate a loopback comment with fact checking and screening. */
export async function synthesizeLoopbackComment(
  postContent: string,
  firstComment: string,
  item: FeedItem,
): Promise<string> {
  const articleSource = item.fullText
    ? `SOURCE ARTICLE: "${item.title}"\n---\n${item.fullText.split(/\s+/).slice(0, 1500).join(' ')}\n---`
    : `SOURCE ARTICLE: "${item.title}"\nSummary: ${item.summary}`;

  const loopbackMsg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post yesterday:

${postContent}

Your first comment was:
"${firstComment}"

${articleSource}

Write a LOOPBACK COMMENT to re-engage the algorithm the morning after publishing. This comment will be posted as a reply to your own post if no one else has commented yet.

PURPOSE: Expand the post's "Interest Graph" by introducing new technical keywords that weren't in the original post. This shows the algorithm new entry points for indexing and surfaces the post to a wider set of technical professionals.

KEYWORD DELTA RULE (CRITICAL): Your loopback comment MUST contain at least 3 specific technical terms, acronyms, or proper nouns that DO NOT appear anywhere in the original post above. These should be semantically related but distinct.

Pick ONE of these structures:

1. SOURCE-FACT DEEP DIVE: [Reference to specific detail in the article] + [Non-obvious technical stat] + [Comparison/Nuance] + [Constraint-based Question]

2. IMPLEMENTATION FRICTION PIVOT: [Context] + [Technical Keyword] + [The 'Human' Bottleneck] + [Role-Specific Question]

3. FUTURE-PROOFING QUESTION: [Industry Trend] + [Technical Counter-point] + [Scenario Question]

RULES:
- Between 25 and 60 words. Keep it tight. A loopback comment is a single focused thought, not a second post.
- Must use facts extracted from the source article above
- Do NOT restate the post's main argument — add a NEW angle
- No em dashes. Use commas or periods instead.
- No AI-isms: "transformative," "revolutionary," "game-changer," "landscape," "navigate," "leverage," etc.
- No contrasting reframe patterns: "It's not X, it's Y" / "Not just X, Y"
- Sound like a real person adding a genuine afterthought the next morning
- If the comment ends with a question, separate the question from the rest of the comment with two line breaks
- Output ONLY the comment text — no preamble, no labels, no quotes`,
    }],
  });

  let raw = loopbackMsg.content[0].type === 'text' ? loopbackMsg.content[0].text.trim() : '';
  if (!raw) return '';

  // Fact verification
  const verificationSource = item.fullText ?? item.summary;
  if (verificationSource) {
    const { verifyPost } = await import('./verify.js');
    const verification = await verifyPost(raw, verificationSource);
    if (verification.changed) {
      console.log(`[loopback] Verifier corrected ${verification.flaggedClaims.length} claim(s)`);
      raw = verification.correctedContent;
    }
  }

  // AI-ism screening
  const { screenReply } = await import('./reply.js');
  raw = await screenReply(raw);

  // Hard clean
  raw = raw.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',').trim();

  // Word count enforcement
  let wc = raw.split(/\s+/).length;
  if (wc < 25 || wc > 75) {
    console.log(`[loopback] Word count ${wc} outside range — revising...`);
    const reviseMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `This LinkedIn comment is ${wc} words, which is ${wc < 25 ? 'too short (minimum 25)' : 'too long (maximum 60)'}. Revise it to be between 25-60 words. Preserve the key fact and the question. No em dashes. Output only the revised comment.\n\n${raw}`,
      }],
    });
    const revised = reviseMsg.content[0].type === 'text' ? reviseMsg.content[0].text.trim() : '';
    if (revised) raw = revised.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',').trim();
  }

  console.log(`[loopback] Ready (${raw.split(/\s+/).length} words)`);
  return raw;
}
