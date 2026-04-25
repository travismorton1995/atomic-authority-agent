import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { approvePost, rejectPost, cancelPost, clearPostImage, setImageChoice, setGeneratedImagePath, getPendingPosts } from './queue.js';
import { pickScheduledTime, pickInsiderScheduledTime } from '../scheduler/windows.js';
import type { PendingPost } from './queue.js';
import { getPendingReply, updateReplyStatus, type PendingReply } from './comment-queue.js';
import { postCommentReply, postOutboundComment } from '../poster/comments.js';
import { renewSession } from '../poster/index.js';
import { getPendingComment, updateCommentStatus, addProfile, incrementDailyCount, popFallbackCandidate, addPendingComment, markPostSeen, type PendingComment } from '../outbound/outbound-queue.js';
import { generateOutboundComment } from '../outbound/generate-comment.js';

// Escape text for Telegram HTML parse mode.
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escape text for Telegram Markdown parse mode.
function escMd(text: string): string {
  return text.replace(/([_*\[\]`~])/g, '\\$1');
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot: Telegraf | null = null;

// Resolvers registered by waitForAction — called when a post is approved or rejected
const pendingResolutions = new Map<string, (action: 'approved' | 'rejected' | 'cancelled') => void>();

export function waitForAction(postId: string): Promise<'approved' | 'rejected' | 'cancelled'> {
  return new Promise((resolve) => {
    pendingResolutions.set(postId, resolve);
  });
}

// Tracks posts waiting for a custom photo upload — maps chatId to postId
const pendingPhotoUploads = new Map<string, string>();

// Tracks draft notification message IDs — used to edit status in-place
const draftMessageIds = new Map<string, number>(); // postId → telegram message_id

// Tracks posts in edit mode — waiting for user to reply with corrected text
const pendingEdits = new Map<string, string>(); // chatId → postId

// Update the draft notification message with a status line
export async function updateDraftStatus(postId: string, status: string): Promise<void> {
  if (!token || !chatId) return;
  const messageId = draftMessageIds.get(postId);
  if (!messageId) return;

  const sender = new Telegraf(token);
  try {
    // Append status to the original message by editing it
    const posts = getPendingPosts();
    const post = posts.find((p: any) => p.id === postId);
    if (!post) return;

    const statusLine = `\n\n*Status:* ${status}`;
    const updatedText = formatMessage(post) + statusLine;

    await sender.telegram.editMessageText(chatId, messageId, undefined, updatedText, {
      parse_mode: 'Markdown',
    });
  } catch (err: any) {
    // Non-fatal — the message may have been deleted or is too old to edit
    console.warn(`[status-update] Could not edit draft message: ${err?.message ?? err}`);
  }
}

// --- Interactive hook selection ---
export interface HookSelectionResult {
  action: 'hook' | 'skip' | 'exit' | 'regenerate';
  selectedHook?: string;
}

interface HookSession {
  hooks: Array<{ hook: string; score: number; technique: string }>;
  articleTitle: string;
  resolve: (result: HookSelectionResult) => void;
}

const hookSessions = new Map<string, HookSession>();

export function waitForHookSelection(sessionId: string, hooks: Array<{ hook: string; score: number; technique: string }>, articleTitle: string): Promise<HookSelectionResult> {
  return new Promise((resolve) => {
    hookSessions.set(sessionId, { hooks, articleTitle, resolve });
  });
}

// Typing indicator — sends "typing..." action every 4s until stopped.
// Returns a stop function. Call it when the operation completes.
let activeTypingInterval: ReturnType<typeof setInterval> | null = null;

export function startTypingIndicator(): () => void {
  if (!token || !chatId) return () => {};
  // Stop any existing typing indicator first
  if (activeTypingInterval) clearInterval(activeTypingInterval);
  const sender = new Telegraf(token);
  activeTypingInterval = setInterval(() => {
    sender.telegram.sendChatAction(chatId!, 'typing').catch(() => {});
  }, 4000);
  // Send immediately too
  sender.telegram.sendChatAction(chatId!, 'typing').catch(() => {});
  return () => {
    if (activeTypingInterval) { clearInterval(activeTypingInterval); activeTypingInterval = null; }
  };
}

export function stopAllTypingIndicators(): void {
  if (activeTypingInterval) { clearInterval(activeTypingInterval); activeTypingInterval = null; }
}

// Optional handler called after a rejection — used by scheduler to auto-regenerate
let onRejectHandler: (() => Promise<void>) | null = null;
let onGenerateHandler: ((url?: string) => Promise<void>) | null = null;
let onPollHandler: (() => Promise<void>) | null = null;
let onOutboundHandler: (() => Promise<void>) | null = null;

export function setOnRejectHandler(handler: () => Promise<void>): void {
  onRejectHandler = handler;
}

export function setOnGenerateHandler(handler: (url?: string) => Promise<void>): void {
  onGenerateHandler = handler;
}

export function setOnPollHandler(handler: () => Promise<void>) : void {
  onPollHandler = handler;
}

let onMetricsHandler: (() => Promise<void>) | null = null;
let onRewriteHandler: ((postId: string) => Promise<void>) | null = null;

export function setOnMetricsHandler(handler: () => Promise<void>): void {
  onMetricsHandler = handler;
}

export function setOnRewriteHandler(handler: (postId: string) => Promise<void>): void {
  onRewriteHandler = handler;
}

export function setOnOutboundHandler(handler: () => Promise<void>): void {
  onOutboundHandler = handler;
}

export function startBot(): void {
  if (!token || !chatId) {
    console.warn('Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    return;
  }

  bot = new Telegraf(token);

  // Register bot command menu (the "/" button in Telegram)
  bot.telegram.setMyCommands([
    { command: 'generate', description: 'Generate a new post draft' },
    { command: 'outbound', description: 'Run outbound comment poll' },
    { command: 'metrics', description: 'Send performance report' },
    { command: 'poll', description: 'Check for new comments on posts' },
    { command: 'insider', description: 'Generate insider post from notes' },
    { command: 'notes', description: 'Add a daily work note' },
    { command: 'login', description: 'Renew LinkedIn session' },
    { command: 'help', description: 'Show all commands' },
  ]).catch(err => console.warn('Failed to set bot commands:', err.message));

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*Atomic Authority — Bot Commands*\n\n' +
      '/generate — Run the content pipeline and generate a new draft\n' +
      '/insider — Generate an insider post from your notes (min 1 note)\n' +
      '/poll — Run a comment reply poll (checks for new comments on your posts)\n' +
      '/outbound — Run the outbound engagement poll (finds posts to comment on)\n' +
      '/metrics — Fetch engagement metrics for all published posts\n' +
      '/types — Show post type distribution vs targets\n' +
      '/notes — Add a daily note (assembled into an insider post weekly)\n' +
      '/login — Open a browser to renew your LinkedIn session\n' +
      '/help — Show this message\n\n' +
      '*Other actions:*\n' +
      '• Send a LinkedIn profile URL to add it to the outbound tracking list\n' +
      '• Send a LinkedIn post URL to generate comment options for that post',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('types', async (ctx) => {
    try {
      const { POST_TYPE_WEIGHTS } = await import('../content/persona.js');
      const history = JSON.parse(readFileSync('posted_history.json', 'utf-8')) as any[];
      const published = history.filter((p: any) => p.status === 'published' && p.draft?.postType);
      const total = published.length;

      const counts: Record<string, number> = {};
      for (const p of published) counts[p.draft.postType] = (counts[p.draft.postType] || 0) + 1;

      const wTotal = Object.values(POST_TYPE_WEIGHTS).reduce((a, b) => a + (b ?? 0), 0);

      const types = Object.entries(POST_TYPE_WEIGHTS)
        .filter(([, w]) => w != null)
        .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0)) as [string, number][];

      const shortNames: Record<string, string> = {
        bridge: 'bridge', explainer: 'explainer', contrarian: 'contrarian',
        'myth-busting': 'myth-bust', 'change-management': 'change-mgmt',
        'hot-take': 'hot-take', prediction: 'prediction',
      };

      const lines = types.map(([type, weight]) => {
        const count = counts[type] || 0;
        const actualPct = total > 0 ? (count / total * 100).toFixed(1) : '0.0';
        const targetPct = (weight / wTotal * 100).toFixed(1);
        const deltaNum = parseFloat(actualPct) - parseFloat(targetPct);
        const delta = deltaNum.toFixed(1);
        const sign = deltaNum > 0 ? '+' : '';
        const indicator = Math.abs(deltaNum) <= 3 ? '\u{1F7E2}' : Math.abs(deltaNum) <= 7 ? '\u{1F7E1}' : '\u{1F534}';
        const name = (shortNames[type] ?? type).padEnd(12);
        return `${indicator}<code> ${name}${String(count).padStart(2)} ${(actualPct + '%').padStart(6)} ${(targetPct + '%').padStart(6)} ${(sign + delta).padStart(6)}</code>`;
      });

      // Add insider separately (no target weight)
      const insiderCount = counts['insider'] || 0;
      if (insiderCount > 0) {
        lines.push(`\u{26AA}<code> ${'insider'.padEnd(12)}${String(insiderCount).padStart(2)}    n/a    n/a      -</code>`);
      }

      const header = `<code> ${'Type'.padEnd(12)} #  Actual Target  Delta</code>`;
      const msg = `<b>Post Type Distribution</b> (${total} published)\n\n${header}\n${lines.join('\n')}`;

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: any) {
      await ctx.reply(`Failed: ${err.message}`).catch(() => {});
    }
  });

  bot.command('generate', async (ctx) => {
    if (!onGenerateHandler) { await ctx.reply('Generator not available.'); return; }

    // Parse optional URL: /generate https://example.com/article
    const args = ctx.message.text.split(/\s+/).slice(1);
    const articleUrl = args.find(a => a.startsWith('http'));

    if (articleUrl) {
      console.log(`Telegram /generate command received with URL: ${articleUrl}`);
      await ctx.reply(`Running content pipeline for:\n${articleUrl}`).catch(err => console.error('[/generate] Failed to send reply:', err));
    } else {
      console.log('Telegram /generate command received');
      await ctx.reply('Running content pipeline...').catch(err => console.error('[/generate] Failed to send reply:', err));
    }

    const stopTyping = startTypingIndicator();
    onGenerateHandler(articleUrl)
      .then((status: any) => {
        stopTyping();
        if (status === 'already_running') {
          ctx.reply('Pipeline is already running — try again shortly.').catch(() => {});
        }
      })
      .catch(err => {
        stopTyping();
        console.error('[/generate] Unexpected error:', err);
        ctx.reply(`Pipeline failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('insider', async (ctx) => {
    const { getNoteCount, assembleNotes } = await import('./daily-notes.js');
    const count = getNoteCount();
    if (count < 1) {
      await ctx.reply('No notes this week. Add at least one with /notes before generating.');
      return;
    }
    const notes = assembleNotes(1);
    if (!notes) {
      await ctx.reply('Failed to assemble notes.');
      return;
    }
    console.log(`Telegram /insider command received (${count} note(s))`);
    // Dynamic import to check pipeline state
    const { runInsiderPipeline, isPipelineRunning } = await import('../content/pipeline.js');
    if (isPipelineRunning()) {
      await ctx.reply('Pipeline is already running — try again shortly.');
      return;
    }
    await ctx.reply(`Generating insider post from ${count} note(s)...`);
    const stopTyping = startTypingIndicator();
    try {
      const post = await runInsiderPipeline(notes);
      if (!post) {
        await ctx.reply('Insider pipeline exited — no post generated.').catch(() => {});
      }
    } catch (err: any) {
      console.error('[/insider] Pipeline failed:', err);
      await ctx.reply(`Insider pipeline failed: ${err.message}`).catch(() => {});
    } finally {
      stopTyping();
    }
  });

  bot.command('poll', async (ctx) => {
    if (!onPollHandler) { await ctx.reply('Poll not available.'); return; }
    console.log('Telegram /poll command received');
    await ctx.reply('Running comment poll...').catch(err => console.error('[/poll] Failed to send reply:', err));
    const stopTyping = startTypingIndicator();
    onPollHandler()
      .then((stats: any) => {
        stopTyping();
        if (stats?.error === 'already running') {
          ctx.reply('Comment poll is already running — try again shortly.').catch(() => {});
        } else if (stats?.error) {
          ctx.reply(`Comment poll failed: ${stats.error}`).catch(() => {});
        } else if (stats) {
          ctx.reply(`Comment poll complete — ${stats.postsChecked} post(s) in last 14 days, ${stats.totalComments} comment(s) found, ${stats.newComments} new.`).catch(() => {});
        }
      })
      .catch(err => {
        stopTyping();
        console.error('[/poll] Unexpected error:', err);
        ctx.reply(`Comment poll failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('outbound', async (ctx) => {
    if (!onOutboundHandler) { await ctx.reply('Outbound poll not available.'); return; }
    console.log('Telegram /outbound command received');
    await ctx.reply('Running outbound poll...').catch(err => console.error('[/outbound] Failed to send reply:', err));
    const stopTyping = startTypingIndicator();
    onOutboundHandler()
      .then(() => { stopTyping(); ctx.reply('Outbound poll complete.').catch(() => {}); })
      .catch(err => {
        stopTyping();
        console.error('[/outbound] Poll error:', err);
        ctx.reply(`Outbound poll failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('metrics', async (ctx) => {
    if (!onMetricsHandler) { await ctx.reply('Metrics fetch not available.'); return; }
    console.log('Telegram /metrics command received');
    await ctx.reply('Fetching engagement metrics...').catch(err => console.error('[/metrics] Failed to send reply:', err));
    const stopTyping = startTypingIndicator();
    onMetricsHandler()
      .then(() => { stopTyping(); ctx.reply('Metrics fetch complete.').catch(() => {}); })
      .catch(err => {
        stopTyping();
        console.error('[/metrics] Fetch error:', err);
        ctx.reply(`Metrics fetch failed: ${err.message}`).catch(() => {});
      });
  });

  bot.command('notes', async (ctx) => {
    const noteText = (ctx.message as any).text?.replace(/^\/notes\s*/, '').trim();
    if (!noteText) {
      const { getNoteCount } = await import('./daily-notes.js');
      const count = getNoteCount();
      await ctx.reply(`📝 ${count} note(s) this week.\n\nUsage: /notes Your note text here`);
      return;
    }
    const { addNote, getNoteCount, isFridayPromptWindow, tryAssembleAndGenerate } = await import('./daily-notes.js');
    addNote(noteText);
    const count = getNoteCount();
    console.log(`[/notes] Note added (${count} this week)`);
    await ctx.reply(`📝 Note saved (${count} this week).`);

    // Only trigger insider generation during the Friday prompt window
    if (count >= 2 && isFridayPromptWindow()) {
      await ctx.reply('Enough notes collected — generating insider post...');
      tryAssembleAndGenerate().catch(err => {
        console.error('[insider] Immediate generation failed:', err);
        ctx.reply(`Insider post generation failed: ${err.message}`).catch(() => {});
      });
    }
  });

  bot.command('login', async (ctx) => {
    console.log('Telegram /login command received');
    await ctx.reply('Opening browser for LinkedIn login — check your screen...').catch(err => console.error('[/login] Failed to send reply:', err));
    try {
      const success = await renewSession();
      if (success) {
        console.log('LinkedIn session renewed successfully via /login');
        await ctx.reply('✅ LinkedIn session is active.').catch(err => console.error('[/login] Failed to send success reply:', err));
      } else {
        console.warn('LinkedIn /login timed out — session not renewed');
        await ctx.reply('❌ Login timed out. Try again.').catch(err => console.error('[/login] Failed to send timeout reply:', err));
      }
    } catch (err: any) {
      console.error('[/login] renewSession error:', err);
      await ctx.reply(`❌ Login failed: ${err.message}`).catch(() => {});
    }
  });

  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as any).data as string;
    if (!data) return;

    const firstColon = data.indexOf(':');
    const action = firstColon === -1 ? data : data.slice(0, firstColon);
    let payload = firstColon === -1 ? '' : data.slice(firstColon + 1);
    console.log(`[callback] action="${action}" payload="${payload.slice(0, 40)}"`);

    try {
      // --- Step 1: Text approved → generate images and show Step 2 ---
      if (action === 'approve') {
        const post = getPendingPosts().find((p: any) => p.id === payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        await ctx.answerCbQuery('Text approved — generating image options...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await updateDraftStatus(payload, '✅ Text approved — selecting image...');

        // Generate images in the background, then send Step 2 message
        (async () => {
          const sender = new Telegraf(token!);

          // Generate AI image (non-fatal)
          let generatedImagePath: string | null = null;
          try {
            const { generateImage } = await import('../content/generate-image.js');
            const postType = (post.draft.postType ?? 'bridge') as any;
            const cleanContent = post.finalContent.replace(/\[\[MENTION:[^\]]+\]\]/g, (m: string) => m.replace(/\[\[MENTION:|\]\]/g, ''));
            generatedImagePath = await generateImage(cleanContent, postType);
            if (generatedImagePath) {
              setGeneratedImagePath(payload, generatedImagePath);
            }
          } catch (err: any) {
            console.warn('Image generation failed (non-fatal):', err?.message ?? err);
          }

          // Send og:image preview if available and reachable
          let hasOgImage = false;
          if (post.draft.imageUrl) {
            try {
              const headRes = await fetch(post.draft.imageUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
              const contentType = headRes.headers.get('content-type') ?? '';
              if (headRes.ok && contentType.startsWith('image/')) {
                await sender.telegram.sendPhoto(chatId!, post.draft.imageUrl, { caption: 'Article image (og:image)' });
                hasOgImage = true;
              } else {
                console.log(`[og:image] Skipped — HEAD returned ${headRes.status}, content-type: ${contentType}`);
              }
            } catch (err: any) {
              console.log(`[og:image] Skipped — not reachable: ${err?.message ?? err}`);
            }
          }

          // Send AI image preview if generated
          const hasAiImage = !!generatedImagePath;
          if (hasAiImage) {
            try {
              const { createReadStream } = await import('fs');
              await sender.telegram.sendPhoto(chatId!, { source: createReadStream(generatedImagePath!) }, { caption: '🤖 AI-generated image' });
            } catch (err: any) {
              console.warn('Failed to send AI image to Telegram (non-fatal):', err?.message ?? err);
            }
          }

          // Search for stock photos — up to 3 options (non-fatal)
          let stockCount = 0;
          try {
            const { searchStockImages } = await import('../content/stock-image.js');
            const cleanContent = post.finalContent.replace(/\[\[MENTION:[^\]]+\]\]/g, (m: string) => m.replace(/\[\[MENTION:|\]\]/g, ''));
            const stockResults = await searchStockImages(cleanContent, 3);

            if (stockResults.length > 0) {
              const { setStockImage } = await import('./queue.js');
              const allOptions = stockResults.map(s => ({ url: s.url, photographer: s.photographer, downloadUrl: s.downloadUrl, description: s.description }));
              // Store first as primary, plus all options for callback selection
              setStockImage(payload, stockResults[0].url, stockResults[0].photographer, stockResults[0].downloadUrl, allOptions);

              for (let i = 0; i < stockResults.length; i++) {
                try {
                  await sender.telegram.sendPhoto(chatId!, stockResults[i].url, {
                    caption: `📸 Stock ${i + 1} — "${stockResults[i].description.slice(0, 80)}" by ${stockResults[i].photographer} (Unsplash)`,
                  });
                  stockCount++;
                } catch (err: any) {
                  console.warn(`Failed to send stock image ${i + 1} to Telegram (non-fatal):`, err?.message ?? err);
                }
              }
            }
          } catch (err: any) {
            console.warn('Stock image search failed (non-fatal):', err?.message ?? err);
          }

          // Build Step 2 keyboard
          const stockButtons = [];
          for (let i = 0; i < stockCount; i++) {
            stockButtons.push([{ text: `📸 Stock photo ${i + 1}`, callback_data: `img_stock:${post.id}:${i}` }]);
          }

          const imgKeyboard = [
            ...(hasOgImage ? [[{ text: '🖼 Use article image', callback_data: `img_og:${post.id}` }]] : []),
            ...(hasAiImage ? [[{ text: '🤖 Use AI image', callback_data: `img_ai:${post.id}` }]] : []),
            ...stockButtons,
            [{ text: '📷 Upload your own', callback_data: `img_upload:${post.id}` }],
            [{ text: '🚫 No image', callback_data: `img_none:${post.id}` }],
            [{ text: '🗑 Cancel', callback_data: `cancel:${post.id}` }],
          ];

          await sender.telegram.sendMessage(chatId!, 'Text approved. Choose an image option:', {
            reply_markup: { inline_keyboard: imgKeyboard },
          });
        })().catch(err => {
          console.error('[Step 2 image selection] Error:', err);
          ctx.reply('Failed to generate image options. Use `npm run approve` to approve manually.').catch(() => {});
        });
      }

      // --- Step 2a: Upload your own photo ---
      if (action === 'img_upload') {
        await ctx.answerCbQuery('Send me a photo...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('📷 Send me the photo you want to use for this post.');
        pendingPhotoUploads.set(String(chatId), payload);
      }

      // --- Step 2: Image selected → schedule or publish immediately ---
      if (action === 'img_og' || action === 'img_ai' || action === 'img_stock' || action === 'img_none') {
        const choice = action === 'img_og' ? 'og' : action === 'img_ai' ? 'ai' : action === 'img_stock' ? 'stock' : 'none' as const;

        // For stock photos, payload is "postId:index" — select the right option
        if (action === 'img_stock') {
          const lastColon = payload.lastIndexOf(':');
          const postId = payload.slice(0, lastColon);
          const stockIdx = parseInt(payload.slice(lastColon + 1));
          const pendingPost = getPendingPosts().find(p => p.id === postId);
          if (pendingPost?.draft.stockImageOptions && stockIdx >= 0 && stockIdx < pendingPost.draft.stockImageOptions.length) {
            const selected = pendingPost.draft.stockImageOptions[stockIdx];
            const { setStockImage } = await import('./queue.js');
            setStockImage(postId, selected.url, selected.photographer, selected.downloadUrl, pendingPost.draft.stockImageOptions);
          }
          // Override payload to just the postId for the rest of the flow
          payload = postId;
        }
        if (choice === 'none') {
          clearPostImage(payload);
        } else {
          setImageChoice(payload, choice);
        }

        // Check if this is an insider post — publish immediately instead of scheduling
        const pendingPost = getPendingPosts().find(p => p.id === payload);
        const isInsider = pendingPost?.draft.postType === 'insider';
        const label = choice === 'og' ? 'article image' : choice === 'ai' ? 'AI image' : 'text only';

        if (isInsider) {
          const scheduledFor = pickInsiderScheduledTime();
          const post = approvePost(payload, scheduledFor);
          if (!post) {
            await ctx.answerCbQuery('Post not found or already actioned.');
            return;
          }
          const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
            timeZone: 'America/Toronto',
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          });
          await ctx.answerCbQuery(`Approved (${label})!`);
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
          await ctx.reply(`Insider post approved (${label}). Scheduled for ${scheduledStr}.`);
          await updateDraftStatus(payload, `📅 Scheduled for ${scheduledStr} | Image: ${label}`);
        } else {
          const scheduledFor = pickScheduledTime();
          const post = approvePost(payload, scheduledFor);
          if (!post) {
            await ctx.answerCbQuery('Post not found or already actioned.');
            return;
          }
          const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
            timeZone: 'America/Toronto',
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          });
          await ctx.answerCbQuery(`Approved (${label})!`);
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
          await ctx.reply(`Post approved (${label}). Scheduled for ${scheduledStr}.`);
          await updateDraftStatus(payload, `📅 Scheduled for ${scheduledStr} | Image: ${label}`);
        }

        pendingResolutions.get(payload)?.('approved');
        pendingResolutions.delete(payload);
      }

      if (action === 'reject') {
        const post = rejectPost(payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        await ctx.answerCbQuery('Rejected.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await updateDraftStatus(payload, '❌ Rejected');
        pendingResolutions.get(payload)?.('rejected');
        pendingResolutions.delete(payload);

        if (onRejectHandler) {
          await ctx.reply('Post rejected. Generating a replacement...');
          onRejectHandler().catch(err => {
            console.error('Failed to generate replacement after rejection:', err);
            ctx.reply('Failed to generate a replacement. Check the logs.').catch(() => {});
          });
        } else {
          await ctx.reply('Post rejected.');
        }
      }

      if (action === 'rewrite') {
        if (!onRewriteHandler) { await ctx.answerCbQuery('Rewrite not available.'); return; }
        await ctx.answerCbQuery('Rewriting...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('Rewriting post with fresh hooks and text...');
        console.log(`Rewrite requested for post ${payload}`);
        onRewriteHandler(payload).catch(err => {
          console.error('[rewrite] Failed:', err);
          ctx.reply(`Rewrite failed: ${err.message}`).catch(() => {});
        });
      }

      if (action === 'edit') {
        const post = getPendingPosts().find((p: any) => p.id === payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        await ctx.answerCbQuery('Edit mode.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

        // Send the raw post text as a copyable message
        const rawText = (post.finalContent ?? post.draft.content)
          .replace(/\[\[MENTION:[^\]]+\]\]/g, (m: string) => m.replace(/\[\[MENTION:|\]\]/g, ''));
        const chatIdStr = String(ctx.chat?.id ?? chatId);
        pendingEdits.set(chatIdStr, payload);
        await ctx.reply('✏️ Copy, edit, and reply with your changes:\n\n' + rawText);
        console.log(`[edit] Edit mode activated for post ${payload}`);
      }

      if (action === 'cancel') {
        const post = cancelPost(payload);
        if (!post) {
          await ctx.answerCbQuery('Post not found or already actioned.');
          return;
        }
        console.log(`Post ${payload} cancelled and removed.`);
        await ctx.answerCbQuery('Cancelled.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await updateDraftStatus(payload, '🗑 Cancelled');
        await ctx.reply('Post cancelled and removed.');
        pendingResolutions.get(payload)?.('cancelled');
        pendingResolutions.delete(payload);
      }

      // --- Comment reply flow ---

      if (action === 'cr_select') {
        const lastColon = payload.lastIndexOf(':');
        const replyId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2 | 3;
        const reply = getPendingReply(replyId);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        const selectedText = reply.replyOptions[optionIdx - 1];
        const selectedLabel = reply.replyLabels?.[optionIdx - 1] ?? `option ${optionIdx}`;
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `💬 <b>Reply preview</b> | ${esc(reply.postType)} | <i>${esc(selectedLabel)}</i>\n\n"${esc(selectedText)}"`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Send', callback_data: `cr_confirm:${replyId}:${optionIdx}` },
                { text: '↩ Back', callback_data: `cr_back:${replyId}` },
              ]],
            },
          },
        );
      }

      if (action === 'cr_confirm') {
        const lastColon = payload.lastIndexOf(':');
        const replyId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2 | 3;
        const reply = getPendingReply(replyId);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        if (reply.status === 'replied') { await ctx.answerCbQuery('Already posted.'); return; }
        await ctx.answerCbQuery('Posting reply…');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        let postErr: Error | null = null;
        try {
          await postCommentReply(reply.postUrl, reply.commentId, reply.replyOptions[optionIdx - 1]);
          updateReplyStatus(replyId, { status: 'replied', selectedOption: optionIdx, repliedAt: new Date().toISOString() });
          console.log(`Comment reply posted — ${reply.commentAuthor} | ${reply.postUrl}`);
        } catch (err: any) {
          postErr = err;
          console.error('[cr_confirm] postCommentReply failed:', err);
        }
        if (postErr) {
          await ctx.editMessageText(
            `❌ <b>Failed to post reply</b>\n\n${esc(postErr.message)}\n\nYou can try again or skip.`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '↩ Try again', callback_data: `cr_back:${replyId}` },
                  { text: '⏭ Skip', callback_data: `cr_skip:${replyId}` },
                ]],
              },
            },
          );
        } else {
          await ctx.editMessageText(
            `✅ <b>Reply posted</b> | ${esc(reply.postType)}\n\nReplied to ${esc(reply.commentAuthor)}.\n\n${reply.postUrl}`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          );
        }
      }

      if (action === 'cr_back') {
        const reply = getPendingReply(payload);
        if (!reply) { await ctx.answerCbQuery('Reply not found.'); return; }
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          formatCommentMessage(reply),
          { parse_mode: 'HTML', reply_markup: buildCommentKeyboard(reply) },
        );
      }

      if (action === 'cr_skip') {
        updateReplyStatus(payload, { status: 'skipped' });
        await ctx.answerCbQuery('Skipped.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      }

      // --- Outbound comment flow ---

      if (action === 'oc_select') {
        const lastColon = payload.lastIndexOf(':');
        const commentId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2;
        const comment = getPendingComment(commentId);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        const selectedText = comment.commentOptions[optionIdx - 1];
        const selectedLabel = comment.commentLabels[optionIdx - 1] ?? `option ${optionIdx}`;
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `📤 <b>Outbound preview</b> | <i>${esc(selectedLabel)}</i>\n\n"${esc(selectedText)}"`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Post', callback_data: `oc_confirm:${commentId}:${optionIdx}` },
                { text: '↩ Back', callback_data: `oc_back:${commentId}` },
              ]],
            },
          },
        );
      }

      if (action === 'oc_confirm') {
        const lastColon = payload.lastIndexOf(':');
        const commentId = payload.slice(0, lastColon);
        const optionIdx = parseInt(payload.slice(lastColon + 1)) as 1 | 2;
        const comment = getPendingComment(commentId);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        if (comment.status === 'posted') { await ctx.answerCbQuery('Already posted.'); return; }
        await ctx.answerCbQuery('Posting comment…');
        // Remove buttons immediately so the user can't double-tap while the browser runs
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        let postErr: Error | null = null;
        try {
          await postOutboundComment(comment.postUrl, comment.commentOptions[optionIdx - 1]);
          updateCommentStatus(commentId, { status: 'posted', selectedOption: optionIdx, postedAt: new Date().toISOString() });
          incrementDailyCount();
          console.log(`Outbound comment posted — ${comment.profileName} | ${comment.postUrl}`);
        } catch (err: any) {
          postErr = err;
          console.error('[oc_confirm] postOutboundComment failed:', err);
        }
        if (postErr) {
          await ctx.editMessageText(
            `❌ <b>Failed to post comment</b>\n\n${esc(postErr.message)}\n\nYou can try again or skip.`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '↩ Try again', callback_data: `oc_back:${commentId}` },
                  { text: '⏭ Skip', callback_data: `oc_skip:${commentId}` },
                  { text: '✖ Exit', callback_data: `oc_exit:${commentId}` },
                ]],
              },
            },
          );
        } else {
          await ctx.editMessageText(
            `✅ <b>Comment posted</b> | ${esc(comment.profileName)}\n\n${comment.postUrl}`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          );
        }
      }

      if (action === 'oc_back') {
        const comment = getPendingComment(payload);
        if (!comment) { await ctx.answerCbQuery('Comment not found.'); return; }
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          formatOutboundMessage(comment),
          { parse_mode: 'HTML', reply_markup: buildOutboundKeyboard(comment) },
        );
      }

      // --- Hook selection callbacks ---
      if (action === 'hk_pick') {
        // payload format: "sessionId:hookIndex"
        const sep = payload.indexOf(':');
        const sessionId = sep >= 0 ? payload.slice(0, sep) : payload;
        const hookIndex = sep >= 0 ? parseInt(payload.slice(sep + 1), 10) : 0;
        const session = hookSessions.get(sessionId);
        if (!session) {
          await ctx.answerCbQuery('Session expired.').catch(() => {});
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
          return;
        }
        const chosen = session.hooks[hookIndex];
        if (!chosen) {
          await ctx.answerCbQuery('Invalid hook.').catch(() => {});
          return;
        }
        await ctx.answerCbQuery(`Hook ${hookIndex + 1} selected.`).catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        console.log(`[hk_pick] Hook ${hookIndex + 1} selected: "${chosen.hook.slice(0, 60)}..."`);
        hookSessions.delete(sessionId);
        session.resolve({ action: 'hook', selectedHook: chosen.hook });
      }

      if (action === 'hk_regen') {
        const session = hookSessions.get(payload);
        await ctx.answerCbQuery(session ? 'Regenerating hooks...' : 'Session expired.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        if (!session) return;
        startTypingIndicator(); // restart typing while generating new hooks
        console.log(`[hk_regen] Regenerating hooks for: "${session.articleTitle.slice(0, 50)}"`);
        hookSessions.delete(payload);
        session.resolve({ action: 'regenerate' });
      }

      if (action === 'hk_skip') {
        const session = hookSessions.get(payload);
        await ctx.answerCbQuery(session ? 'Skipping to next article...' : 'Session expired.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        if (!session) return;
        console.log(`[hk_skip] Skipping article: "${session.articleTitle.slice(0, 50)}"`);
        hookSessions.delete(payload);
        session.resolve({ action: 'skip' });
      }

      if (action === 'hk_exit') {
        const session = hookSessions.get(payload);
        await ctx.answerCbQuery(session ? 'Pipeline exited.' : 'Session expired.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        if (!session) return;
        console.log(`[hk_exit] User exited hook selection`);
        hookSessions.delete(payload);
        session.resolve({ action: 'exit' });
      }

      if (action === 'oc_skip') {
        console.log(`[oc_skip] Skipping comment ${payload}`);
        updateCommentStatus(payload, { status: 'skipped' });
        await ctx.answerCbQuery('Skipped.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        let next = popFallbackCandidate();
        if (!next) {
          // Ranked list exhausted — run a fresh outbound poll to find more candidates
          console.log('[oc_skip] Ranked list exhausted — running fresh outbound poll...');
          await ctx.reply('List exhausted. Running a fresh poll...').catch(() => {});
          try {
            const { runOutboundPoll } = await import('./outbound-poll.js');
            await runOutboundPoll();
          } catch (err: any) {
            console.error('[oc_skip] Fresh poll failed:', err);
            await ctx.reply(`Fresh poll failed: ${err.message}`).catch(() => {});
          }
          return;
        }

        markPostSeen(next.id);
        console.log(`[oc_skip] Generating comment for fallback: ${next.profileName} | ${next.url}`);
        await ctx.reply('Generating next option...').catch(() => {});

        let nextGenerated;
        try {
          nextGenerated = await generateOutboundComment(
            { text: next.text, authorName: next.authorName, url: next.url, articleUrl: next.articleUrl },
            { insider: next.insider, colleague: next.colleague },
          );
        } catch (err: any) {
          console.error('[oc_skip] Failed to generate fallback comment:', err);
          await ctx.reply(`Could not generate comment for next post: ${err.message}`).catch(() => {});
          return;
        }

        const nextComment: PendingComment = {
          id: `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          profileUrl: next.profileUrl,
          profileName: next.profileName,
          postUrl: next.url,
          postSnippet: next.text.split('\n')[0].slice(0, 100),
          postSummary: nextGenerated.postSummary,
          postAgeHours: next.ageHours,
          commentOptions: [nextGenerated.options[0].text, nextGenerated.options[1].text],
          commentLabels: [nextGenerated.options[0].label, nextGenerated.options[1].label],
          recommendationReason: nextGenerated.recommendationReason,
          reasoning: nextGenerated.reasoning,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        addPendingComment(nextComment);
        console.log(`[oc_skip] Sending fallback comment notification for ${next.profileName}`);
        await notifyOutboundComment(nextComment);
      }

      if (action === 'oc_exit') {
        console.log(`[oc_exit] User exited outbound flow, skipping comment ${payload}`);
        updateCommentStatus(payload, { status: 'skipped' });
        await ctx.answerCbQuery('Exited.').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        await ctx.reply('Outbound comment flow exited.').catch(() => {});
      }

    } catch (err: any) {
      if (err?.response?.error_code === 400) {
        console.log(`[callback] Swallowed 400 for action="${action}" — ${err?.response?.description ?? err.message}`);
        return;
      }
      console.error('Unexpected error handling callback query:', err);
    }
  });

  // Launch with retry — Telegram returns 409 if a previous polling session is still active.
  // Retry on the same bot instance (handlers are preserved) until the old session expires.
  (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await bot!.launch();
        console.log('Telegram bot connected and polling.');
        return;
      } catch (err: any) {
        const is409 = err?.response?.error_code === 409 || String(err?.message).includes('409');
        if (is409 && attempt < 10) {
          console.warn(`Telegram 409 conflict (attempt ${attempt}/10) — retrying in 10s...`);
          await new Promise(r => setTimeout(r, 10_000));
        } else {
          console.error('Telegram bot failed to launch after all retries:', err);
          return;
        }
      }
    }
  })();
  console.log('Telegram bot starting...');

  // Photo upload handler — receives custom images for posts
  bot.on('photo', async (ctx) => {
    const chatIdStr = String(ctx.chat.id);
    const postId = pendingPhotoUploads.get(chatIdStr);
    if (!postId) return; // No pending upload
    pendingPhotoUploads.delete(chatIdStr);

    try {
      // Get the highest-resolution photo
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const file = await ctx.telegram.getFile(best.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

      // Download and save locally
      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = file.file_path?.endsWith('.png') ? '.png' : '.jpg';
      const imgDir = path.resolve('generated_images');
      if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
      const filename = `custom_${Date.now()}${ext}`;
      const filepath = path.join(imgDir, filename);
      writeFileSync(filepath, buffer);

      // Set as post image
      setGeneratedImagePath(postId, filepath);
      setImageChoice(postId, 'custom');
      console.log(`[img_upload] Custom photo saved for ${postId}: ${filepath}`);

      // Approve and handle posting (insider = immediate, others = scheduled)
      const post = getPendingPosts().find(p => p.id === postId);
      const isInsider = post?.draft.postType === 'insider';

      if (isInsider) {
        const scheduledFor = pickInsiderScheduledTime();
        const approved = approvePost(postId, scheduledFor);
        if (!approved) { await ctx.reply('Post not found or already actioned.'); return; }
        const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
          timeZone: 'America/Toronto',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
        await ctx.reply(`📷 Photo saved. Insider post approved (custom image). Scheduled for ${scheduledStr}.`);
      } else {
        const scheduledFor = pickScheduledTime();
        const approved = approvePost(postId, scheduledFor);
        if (!approved) { await ctx.reply('Post not found or already actioned.'); return; }
        const scheduledStr = new Date(scheduledFor).toLocaleString('en-US', {
          timeZone: 'America/Toronto',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
        await ctx.reply(`📷 Photo saved. Post approved (custom image). Scheduled for ${scheduledStr}.`);
      }

      pendingResolutions.get(postId)?.('approved');
      pendingResolutions.delete(postId);
    } catch (err: any) {
      console.error('[img_upload] Error processing photo:', err);
      await ctx.reply(`Failed to process photo: ${err.message}`).catch(() => {});
    }
  });

  // LinkedIn URL listener — profile URLs get added to outbound list,
  // post URLs trigger ad-hoc comment generation.
  bot.on('message', async (ctx) => {
    const text = (ctx.message as any).text as string | undefined;
    if (!text) return;

    // Check for pending edit — user replied with corrected post text
    const chatIdStr = String(ctx.chat?.id);
    const editPostId = pendingEdits.get(chatIdStr);
    if (editPostId && !text.startsWith('/')) {
      pendingEdits.delete(chatIdStr);
      try {
        const { updatePostContent } = await import('./queue.js');
        const updated = updatePostContent(editPostId, text);
        if (updated) {
          console.log(`[edit] Post ${editPostId} updated with user edits.`);
          await notifyTelegram(updated);
          console.log('[edit] Resent approval message with updated content.');
        } else {
          await ctx.reply('Post not found or already actioned.').catch(() => {});
        }
      } catch (err: any) {
        console.error(`[edit] Failed to update post: ${err?.message ?? err}`);
        await ctx.reply(`Edit failed: ${err?.message ?? 'unknown error'}`).catch(() => {});
      }
      return;
    }

    // Check for post URL first (more specific match)
    const postMatch = text.match(/https:\/\/www\.linkedin\.com\/feed\/update\/[^\s?#]+/) ??
                      text.match(/https:\/\/www\.linkedin\.com\/posts\/[^\s?#]+/);
    if (postMatch) {
      const postUrl = postMatch[0];
      console.log(`[ad-hoc comment] Received post URL: ${postUrl}`);
      await ctx.reply('Scraping post and generating comment options...').catch(() => {});

      try {
        const { scrapePostByUrl } = await import('../outbound/scrape-post.js');
        const scraped = await scrapePostByUrl(postUrl);
        console.log(`[ad-hoc comment] Scraped: "${scraped.text.slice(0, 60)}..." by ${scraped.authorName}${scraped.isRepost ? ' (REPOST)' : ''}`);

        if (scraped.isRepost) {
          await ctx.reply(`⚠️ This looks like a repost, not an original post. Comment on the original instead — your engagement will be more visible there.`);
          return;
        }

        // Mark the post as seen so the outbound poll won't suggest it again.
        // Extract activity ID from both URL formats:
        //   /feed/update/urn:li:activity:1234567890/
        //   /posts/username_slug-activity-1234567890-xxxx
        const urnMatch = postUrl.match(/(urn:li:activity:\d+)/);
        const activityMatch = postUrl.match(/activity[:-](\d{15,})/);
        if (urnMatch) {
          markPostSeen(urnMatch[1]);
        } else if (activityMatch) {
          markPostSeen(`urn:li:activity:${activityMatch[1]}`);
        }
        // Also mark the URL itself as a fallback
        markPostSeen(postUrl);

        // Resolve profile URL from the post page so cooldown tracking works.
        // For /posts/ URLs the profile slug is embedded; for /feed/update/ we use the author name.
        const { normalizeProfileUrl } = await import('../outbound/outbound-queue.js');
        let profileUrl = '';
        if (scraped.profileUrl) {
          profileUrl = normalizeProfileUrl(scraped.profileUrl);
        }

        // Check if this profile is already tracked — use insider/colleague flags if so
        const existingProfiles = (await import('../outbound/outbound-queue.js')).getActiveProfiles();
        const tracked = existingProfiles.find(p => p.url === profileUrl);

        const { generateOutboundComment } = await import('../outbound/generate-comment.js');
        const generated = await generateOutboundComment(
          { text: scraped.text, authorName: scraped.authorName, url: postUrl, articleUrl: scraped.articleUrl },
          {
            insider: tracked?.insider ?? false,
            colleague: tracked?.colleague ?? false,
            stranger: !tracked,
          },
        );

        const comment: PendingComment = {
          id: `oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          profileUrl,
          profileName: scraped.authorName,
          postUrl,
          postSnippet: scraped.text.split('\n')[0].slice(0, 100),
          postSummary: generated.postSummary,
          postAgeHours: null,
          commentOptions: [generated.options[0].text, generated.options[1].text],
          commentLabels: [generated.options[0].label, generated.options[1].label],
          recommendationReason: generated.recommendationReason,
          reasoning: generated.reasoning,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        addPendingComment(comment);
        await notifyOutboundComment(comment);
        console.log(`[ad-hoc comment] Comment options sent for ${scraped.authorName} (profile: ${profileUrl || 'unknown'})`);
      } catch (err: any) {
        console.error('[ad-hoc comment] Failed:', err);
        await ctx.reply(`Failed to generate comment: ${err.message}`).catch(() => {});
      }
      return;
    }

    // Check for profile URL
    const profileMatch = text.match(/https:\/\/www\.linkedin\.com\/(in|company|showcase)\/[^\s?#]+/);
    if (profileMatch) {
      const url = profileMatch[0];
      const { profile, existed } = addProfile(url);
      if (existed) {
        await ctx.reply(`Already tracking: ${profile.name} (${profile.url})`);
      } else {
        await ctx.reply(`✅ Added to outbound list: ${profile.name}\n${profile.url}`);
      }
      return;
    }

    // Capture plain text as a daily note if within the prompt window
    const { isWithinPromptWindow, isFridayPromptWindow, addNote, getNoteCount, tryAssembleAndGenerate } = await import('./daily-notes.js');
    if (isWithinPromptWindow() && text.length > 10) {
      addNote(text);
      const count = getNoteCount();
      await ctx.reply(`📝 Note saved (${count} this week).`);

      // Only trigger insider generation during the Friday prompt window
      if (count >= 2 && isFridayPromptWindow()) {
        await ctx.reply('Enough notes collected — generating insider post...');
        tryAssembleAndGenerate().catch(err => {
          console.error('[insider] Immediate generation failed:', err);
          ctx.reply(`Insider post generation failed: ${err.message}`).catch(() => {});
        });
      }
    }
  });

  // Catch bot-level errors to prevent crashes from killing the entire bot
  bot.catch((err: any) => {
    console.error('[telegram-bot] Unhandled error:', err?.message ?? err);
  });

  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

export async function sendAlert(message: string): Promise<void> {
  if (!token || !chatId) {
    console.warn(`[ALERT] ${message}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, `⚠️ *Atomic Authority Alert*\n\n${message}`, {
    parse_mode: 'Markdown',
  });
}

export async function sendMessage(message: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
  if (!token || !chatId) {
    console.log(`[REPORT]\n${message}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, message, { parse_mode: parseMode });
}

export async function sendPhotoBuffer(photo: Buffer, caption?: string): Promise<void> {
  if (!token || !chatId) {
    console.log(`[PHOTO] (${photo.length} bytes) ${caption ?? ''}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendPhoto(chatId, { source: photo }, caption ? { caption } : {});
}

export async function sendDocumentBuffer(doc: Buffer, filename: string, caption?: string): Promise<void> {
  if (!token || !chatId) {
    console.log(`[DOC] (${doc.length} bytes) ${filename} ${caption ?? ''}`);
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendDocument(chatId, { source: doc, filename }, caption ? { caption } : {});
}

export async function notifyTelegram(post: PendingPost): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- TELEGRAM NOTIFICATION (not configured) ---');
    console.log(formatMessage(post));
    console.log('----------------------------------------------\n');
    return;
  }

  const sender = new Telegraf(token);
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 15 * 1000;

  // Step 1: Text approval only — no images shown yet
  const keyboard = [
    [
      { text: '✅ Approve text', callback_data: `approve:${post.id}` },
      { text: '✏️ Edit', callback_data: `edit:${post.id}` },
      { text: '🔄 Rewrite', callback_data: `rewrite:${post.id}` },
    ],
    [
      { text: '❌ Reject', callback_data: `reject:${post.id}` },
      { text: '🗑 Cancel', callback_data: `cancel:${post.id}` },
    ],
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sent = await sender.telegram.sendMessage(chatId, formatMessage(post), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
      draftMessageIds.set(post.id, sent.message_id);
      return;
    } catch (err: any) {
      const isNetwork = err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.type === 'system';
      if (isNetwork && attempt < MAX_RETRIES) {
        console.warn(`Telegram send failed (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
}

export interface HookSelectionArticle {
  title: string;
  link: string;
  summary: string;         // 1-2 sentence summary
  score: number;
  scoreBreakdown: { intersection: number; novelty: number; geography: number; npx: number };
  postType: string;
  balanceMultiplier: number;
  recencyMultiplier: number;
  postContentFeedback: number;
}

export interface NextUpCandidate {
  title: string;
  combinedScore: number;
  postType: string;
}

export async function notifyHookSelection(
  sessionId: string,
  article: HookSelectionArticle,
  hooks: Array<{ hook: string; score: number; technique: string }>,
  nextUp: NextUpCandidate[],
): Promise<void> {
  if (!token || !chatId) {
    console.log('[hook-selection] Telegram not configured');
    return;
  }

  const sender = new Telegraf(token);
  const bd = article.scoreBreakdown;

  let msg = `<b>Article:</b> ${esc(article.title)}\n`;
  msg += `<a href="${esc(article.link)}">View article</a>\n\n`;
  msg += `<b>Score:</b> ${article.score.toFixed(1)} (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx})\n`;
  msg += `Balance: ${article.balanceMultiplier.toFixed(2)}x | Recency: ${article.recencyMultiplier.toFixed(2)}x | Feedback: ${article.postContentFeedback.toFixed(2)}x\n`;
  msg += `<b>Type:</b> ${esc(article.postType)}\n\n`;
  msg += `<b>Summary:</b> ${esc(article.summary)}\n\n`;
  msg += `<b>Hook options:</b>\n`;

  for (let i = 0; i < hooks.length; i++) {
    msg += `\n${i + 1}. <i>[${esc(hooks[i].technique)}]</i> (${hooks[i].score}/10)\n${esc(hooks[i].hook)}\n`;
  }

  if (nextUp.length > 0) {
    msg += `\n<b>Next up (if skipped):</b>\n`;
    for (const c of nextUp) {
      msg += `  • ${c.combinedScore.toFixed(1)} — "${esc(c.title.slice(0, 50))}" <i>(${c.postType})</i>\n`;
    }
  }

  const hookButtons = hooks.map((_, i) => ({
    text: `Hook ${i + 1}`,
    callback_data: `hk_pick:${sessionId}:${i}`,
  }));

  // Split hook buttons into rows of 3
  const hookRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < hookButtons.length; i += 3) {
    hookRows.push(hookButtons.slice(i, i + 3));
  }

  const keyboard = [
    ...hookRows,
    [
      { text: '🔄 Regenerate', callback_data: `hk_regen:${sessionId}` },
      { text: 'Skip article', callback_data: `hk_skip:${sessionId}` },
      { text: 'Exit', callback_data: `hk_exit:${sessionId}` },
    ],
  ];

  // Stop typing indicator — we're now waiting for user input, not processing
  stopAllTypingIndicators();

  await sender.telegram.sendMessage(chatId, msg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
    link_preview_options: { is_disabled: true },
  });
}

function getNextCandidatesSummary(): string {
  try {
    if (!existsSync('candidates.json')) return '';
    const store = JSON.parse(readFileSync('candidates.json', 'utf-8'));
    const next = (store.candidates as any[]).slice(store.nextIndex, store.nextIndex + 2);
    if (next.length === 0) return '';
    const lines = next.map((c: any, i: number) => {
      const combined = c.combinedScore != null ? c.combinedScore.toFixed(1) : c.articleScore;
      return `  #${store.nextIndex + i + 1} · ${combined} · "${escMd(c.item.title.slice(0, 50))}" _(${c.postType})_`;
    });
    return `\n\n*If rejected, next up:*\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function formatMessage(post: PendingPost): string {
  const cringeNote = post.screening.cringeScore > 3
    ? `Cringe: ${post.screening.cringeScore}/10 — auto-revised`
    : `Cringe: ${post.screening.cringeScore}/10 — clean`;

  const commentSection = post.draft.firstComment
    ? `\n\n*First comment:*\n${escMd(post.draft.firstComment)}`
    : '';

  const sourceDateStr = post.draft.sourceDate
    ? new Date(post.draft.sourceDate).toLocaleDateString('en-US', {
        timeZone: 'America/Toronto',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const safeTitle = escMd(post.draft.sourceTitle);
  const sourceLink = post.draft.sourceUrl ? `\n${escMd(post.draft.sourceUrl)}` : '';
  const sourceNote = sourceDateStr
    ? `*Source:* ${safeTitle} _(${sourceDateStr})_${sourceLink}`
    : `*Source:* ${safeTitle}${sourceLink}`;

  const feedNote = post.draft.sourceFeed ? `*Feed:* ${post.draft.sourceFeed}` : '';
  const bd = post.draft.scoreBreakdown;
  const bdStr = bd ? ` (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx})` : '';
  const multiplierStr = (post.draft.balanceMultiplier !== undefined && post.draft.recencyMultiplier !== undefined && post.draft.postContentFeedback !== undefined)
    ? ` × B:${post.draft.balanceMultiplier.toFixed(2)} R:${post.draft.recencyMultiplier.toFixed(2)} P:${post.draft.postContentFeedback.toFixed(2)}`
    : '';
  const scoreNote = post.draft.combinedScore !== undefined
    ? `*Score:* ${post.draft.combinedScore.toFixed(2)}${bdStr}${multiplierStr}`
    : '';
  const metaLine = [feedNote, scoreNote].filter(Boolean).join(' | ');

  // Escape Markdown in post body, then re-apply bold for mentions
  const displayContent = escMd(post.finalContent).replace(/\\\[\\\[MENTION:([^\]]+)\\\]\\\]/g, '*$1*');

  const wc = post.wordCount ?? post.finalContent.split(/\s+/).filter(Boolean).length;

  return `*New draft ready* | ${post.draft.postType} | ${wc} words | ${cringeNote}

${sourceNote}${metaLine ? `\n${metaLine}` : ''}

${displayContent}${commentSection}${getNextCandidatesSummary()}`;
}

// --- Comment reply notification ---

function buildCommentKeyboard(reply: PendingReply) {
  return {
    inline_keyboard: [
      [
        { text: '1️⃣', callback_data: `cr_select:${reply.id}:1` },
        { text: '2️⃣', callback_data: `cr_select:${reply.id}:2` },
        { text: '3️⃣', callback_data: `cr_select:${reply.id}:3` },
        { text: '⏭ Skip', callback_data: `cr_skip:${reply.id}` },
      ],
    ],
  };
}

function formatCommentMessage(reply: PendingReply): string {
  const threadLabel = reply.isReply ? 'reply-to-reply' : 'comment';
  const reasoningSection = reply.reasoning
    ? `\n<b>AI reasoning:</b> <i>${esc(reply.reasoning)}</i>\n`
    : '';

  return `💬 <b>New ${threadLabel}</b> | ${reply.postType}
${reply.postUrl}
<i>"${esc(reply.postSnippet)}…"</i>

<b>From:</b> ${esc(reply.commentAuthor)} <i>(${esc(reply.commentType)})</i>
"${esc(reply.commentText)}"
${reasoningSection}
<b>Reply options:</b>
1. ⭐ <i>${esc(reply.replyLabels?.[0] ?? 'option 1')}:</i> ${esc(reply.replyOptions[0])}${reply.recommendationReason ? `\n   <i>↳ ${esc(reply.recommendationReason)}</i>` : ''}

2. <i>${esc(reply.replyLabels?.[1] ?? 'option 2')}:</i> ${esc(reply.replyOptions[1])}

3. <i>${esc(reply.replyLabels?.[2] ?? 'option 3')}:</i> ${esc(reply.replyOptions[2])}`;
}

// --- Outbound comment notification ---

function buildOutboundKeyboard(comment: PendingComment) {
  return {
    inline_keyboard: [[
      { text: '1️⃣', callback_data: `oc_select:${comment.id}:1` },
      { text: '2️⃣', callback_data: `oc_select:${comment.id}:2` },
      { text: '⏭ Skip', callback_data: `oc_skip:${comment.id}` },
      { text: '✖ Exit', callback_data: `oc_exit:${comment.id}` },
    ]],
  };
}

function formatOutboundMessage(comment: PendingComment): string {
  const ageLabel = comment.postAgeHours !== null && comment.postAgeHours !== undefined
    ? `${comment.postAgeHours.toFixed(1)}h ago`
    : 'unknown age';
  const goldenWindow = comment.postAgeHours !== null && comment.postAgeHours !== undefined && comment.postAgeHours < 2;
  const summarySection = comment.postSummary ? `\n<b>Post:</b> <i>${esc(comment.postSummary)}</i>\n` : '';
  const whySection = comment.reasoning ? `\n<b>Why:</b> <i>${esc(comment.reasoning)}</i>\n` : '';

  return `📤 <b>Outbound comment</b> | ${esc(comment.profileName)} | <i>${ageLabel}${goldenWindow ? ' ⚡' : ''}</i>
${comment.postUrl}
<i>"${esc(comment.postSnippet)}…"</i>
${summarySection}${whySection}
<b>Comment options:</b>
1. ⭐ <i>${esc(comment.commentLabels[0])}:</i> ${esc(comment.commentOptions[0])}${comment.recommendationReason ? `\n   <i>↳ ${esc(comment.recommendationReason)}</i>` : ''}

2. <i>${esc(comment.commentLabels[1])}:</i> ${esc(comment.commentOptions[1])}`;
}

export async function notifyOutboundComment(comment: PendingComment): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- OUTBOUND COMMENT (not configured) ---');
    console.log(formatOutboundMessage(comment));
    console.log('-----------------------------------------\n');
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, formatOutboundMessage(comment), {
    parse_mode: 'HTML',
    reply_markup: buildOutboundKeyboard(comment),
  });
}

export async function notifyCommentReply(reply: PendingReply): Promise<void> {
  if (!token || !chatId) {
    console.log('\n--- COMMENT REPLY (not configured) ---');
    console.log(formatCommentMessage(reply));
    console.log('--------------------------------------\n');
    return;
  }
  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(chatId, formatCommentMessage(reply), {
    parse_mode: 'HTML',
    reply_markup: buildCommentKeyboard(reply),
  });
}
