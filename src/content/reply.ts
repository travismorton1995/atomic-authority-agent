import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './persona.js';

const client = new Anthropic();

export type CommentType = 'question' | 'agreement' | 'pushback' | 'adds-context' | 'generic';

export function classifyComment(text: string): CommentType {
  const lower = text.toLowerCase();
  if (
    text.includes('?') ||
    /\b(how|what|why|when|where|who|would|could|can you|do you|have you)\b/.test(lower)
  ) return 'question';
  if (
    /\b(disagree|not sure|actually|however|but|pushback|counterpoint|wrong|misses|overlooks)\b/.test(lower)
  ) return 'pushback';
  if (
    /\b(great point|good point|exactly|agree|well said|spot on|100%|this|nailed it|so true)\b/.test(lower)
  ) return 'agreement';
  if (text.length > 120) return 'adds-context';
  return 'generic';
}

const REPLY_INSTRUCTIONS: Record<CommentType, string> = {
  question:
    'Answer the specific question concisely. Add one insight they didn\'t ask for. End with a follow-up that keeps the thread going — not a generic "what do you think?" but something specific to the exchange.',
  agreement:
    'Acknowledge their point, then extend it — add a nuance, counter-example, or specific detail they didn\'t mention. Don\'t just validate. Make the reply worth reading.',
  pushback:
    'Engage with the pushback directly. Acknowledge what\'s valid, then defend your position with a specific reason or fact. Stay measured, not defensive.',
  'adds-context':
    'Reference their specific point by name or detail. Build on what they added — don\'t restate it. The reply should feel like a real conversation between two people who know the subject.',
  generic:
    'Keep it brief and genuine. Acknowledge their comment and add one concrete thought that moves the conversation forward.',
};

export async function generateReplies(
  post: { content: string; postType: string },
  comment: { author: string; text: string },
): Promise<[string, string, string]> {
  const commentType = classifyComment(comment.text);
  const instruction = REPLY_INSTRUCTIONS[commentType];

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:
${post.content}

${comment.author} left this comment:
"${comment.text}"

Comment type: ${commentType}
Instruction: ${instruction}

Generate 3 distinct reply options. Each must:
- Be 1–3 sentences
- Sound like the post author (same voice, same technical authority)
- NOT open with "Great question", "Thanks for", "I", or any hollow opener
- Be meaningfully different from each other — different angle, tone, or level of detail

Return ONLY a valid JSON array of 3 strings — no markdown, no extra text:
["reply 1", "reply 2", "reply 3"]`,
    }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrayMatch) throw new Error('Reply generator returned no JSON array');

  const replies = JSON.parse(arrayMatch[0]) as string[];
  if (replies.length < 3) throw new Error(`Expected 3 reply options, got ${replies.length}`);

  return [replies[0], replies[1], replies[2]];
}
