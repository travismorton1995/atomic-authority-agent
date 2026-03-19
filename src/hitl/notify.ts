import { PendingPost } from './queue.js';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export async function notifyDiscord(post: PendingPost): Promise<void> {
  if (!WEBHOOK_URL || WEBHOOK_URL === 'your_discord_webhook_url_here') {
    console.log('\n--- DISCORD NOTIFICATION (webhook not configured) ---');
    console.log(formatNotification(post));
    console.log('-----------------------------------------------------\n');
    return;
  }

  const body = {
    content: formatNotification(post),
    username: 'Atomic Authority',
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${res.statusText}`);
  }
}

function formatNotification(post: PendingPost): string {
  const cringeNote = post.screening.cringeScore > 3
    ? ` *(Cringe score ${post.screening.cringeScore}/10 — auto-revised)*`
    : ` *(Cringe score ${post.screening.cringeScore}/10 — clean)*`;

  return `**New LinkedIn draft ready for review**${cringeNote}

**Post Type:** ${post.draft.postType}
**Source:** ${post.draft.sourceTitle}
**URL:** ${post.draft.sourceUrl}

**Draft:**
${post.finalContent}

**To approve:** \`npm run approve -- --id ${post.id}\`
**To reject:** \`npm run reject -- --id ${post.id}\``;
}
