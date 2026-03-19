import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';
import { PostType, SYSTEM_PROMPT, POST_TYPE_INSTRUCTIONS } from './persona.js';

const client = new Anthropic();

export interface DraftPost {
  content: string;
  firstComment: string;
  postType: PostType;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  generatedAt: string;
}

export async function synthesizePost(item: FeedItem, postType: PostType): Promise<DraftPost> {
  const userPrompt = `NEWS ITEM:
Title: ${item.title}
Source: ${item.source}
Date: ${item.pubDate}
URL: ${item.link}
Summary: ${item.summary}

POST TYPE: ${postType}
INSTRUCTION: ${POST_TYPE_INSTRUCTIONS[postType]}

Write the LinkedIn post now. Output only the post text — no preamble, no "here is your post," no quotation marks wrapping the whole thing.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0].type === 'text' ? message.content[0].text.trim() : '';

  // Generate first comment (Haiku — cheap, adds source URL + brief follow-up)
  const commentMessage = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:\n\n${content}\n\nWrite a first comment: exactly 1 sentence of follow-up thought, then the source URL on its own line. No more than that. No preamble, no sign-off.\n\nFormat:\n<one sentence>\n\n${item.link}`,
    }],
  });

  const firstComment = commentMessage.content[0].type === 'text' ? commentMessage.content[0].text.trim() : item.link;

  return {
    content,
    firstComment,
    postType,
    sourceTitle: item.title,
    sourceUrl: item.link,
    sourceDate: item.pubDate,
    generatedAt: new Date().toISOString(),
  };
}
