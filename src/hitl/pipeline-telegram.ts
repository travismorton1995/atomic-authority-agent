// Telegram UI for Pipeline V2 — handles the 8-step interactive workflow.

import {
  createSession,
  getSession,
  saveSession,
  deleteSession,
  getArticlePage,
  selectArticle,
  nextArticlePage,
  generateTypeOptions,
  selectType,
  backToArticleSelection,
  selectHook,
  backToArticleFromHook,
  generateHookCandidates,
  screenHookCandidates,
  generatePost,
  approvePostText,
  backToArticleFromPost,
  generateComments,
  approveComments,
  updateComments,
  processMentions,
  confirmMentions,
  type PipelineSession,
  type ArticleOption,
} from '../content/pipeline-v2.js';
import {
  getTypeBalanceMultipliers,
  fetchArticleForCandidate,
  type ScoredCandidate,
} from '../content/pipeline.js';
import { addPendingPost } from './queue.js';
import { PostType } from '../content/persona.js';
import { Telegraf } from 'telegraf';
import { readFileSync, existsSync, createReadStream } from 'fs';
import { pickScheduledTime, TIME_WINDOWS } from '../scheduler/windows.js';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Step 1: Article Selection ────────────────────────────────────────

export function formatArticleSelectionMessage(articles: ArticleOption[]): string {
  if (articles.length === 0) return 'No more articles available.';

  const lines: string[] = ['📰 <b>Step 1: Select an Article</b>\n'];

  for (const a of articles) {
    const bd = a.scoreBreakdown;
    lines.push(
      `<b>${a.rank}. ${esc(a.title)}</b>`,
      `<a href="${esc(a.link)}">${esc(a.source)}</a>`,
      `Score: <b>${a.combinedScore.toFixed(1)}</b> (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx}) | Bal: ${a.balanceMultiplier.toFixed(1)}x | Rec: ${a.recencyMultiplier.toFixed(1)}x`,
      '',
      `<i>${esc(a.synopsis)}</i>`,
      '',
      `Suggested: <b>${a.suggestedPostType}</b> — ${esc(a.reasoning)}`,
      '━━━━━━━━━━━━━━━━━━━━━━',
    );
  }

  return lines.join('\n');
}

export function buildArticleKeyboard(session: PipelineSession, articles: ArticleOption[]) {
  const buttons = articles.map((a, i) => ({
    text: String(a.rank),
    callback_data: `pv2_art:${session.id}:${i}`,
  }));

  const hasMore = session.pageOffset + 5 < session.allCandidates.length;
  const row2: Array<{ text: string; callback_data: string }> = [];
  if (hasMore) row2.push({ text: '▶ Next 5', callback_data: `pv2_art_next:${session.id}` });
  row2.push({ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` });

  return {
    inline_keyboard: [buttons, row2],
  };
}

// ── Step 2: Post-Type Selection ──────────────────────────────────────

export function formatTypeSelectionMessage(
  session: PipelineSession,
): string {
  const options = session.typeOptions!;
  const article = session.selectedArticle!;

  const lines: string[] = [
    `📝 <b>Step 2: Select Post Type</b>`,
    `Article: <i>${esc(article.item.title.slice(0, 60))}…</i>`,
    '',
  ];

  const statusEmoji = { under: '🟢 under target', 'on-target': '🟡 on target', over: '🔴 over target' };

  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const recommended = i === 0 ? ' ⭐' : '';
    lines.push(
      `<b>${i + 1}. ${o.postType}</b>${recommended} (fit: ${o.fit}/10) — ${statusEmoji[o.balanceStatus]}`,
      `   ${esc(o.angle)}`,
      '',
    );
  }

  return lines.join('\n');
}

export function buildTypeKeyboard(session: PipelineSession) {
  const count = session.typeOptions!.length;
  const row1 = Array.from({ length: count }, (_, i) => ({
    text: `${i + 1}${i === 0 ? ' ⭐' : ''}`,
    callback_data: `pv2_type:${session.id}:${i}`,
  }));

  return {
    inline_keyboard: [
      row1,
      [
        { text: '↩ Back', callback_data: `pv2_type_back:${session.id}` },
        { text: '✖ Exit', callback_data: `pv2_exit:${session.id}` },
      ],
    ],
  };
}

// ── Step 3: Hook Generation ──────────────────────────────────────────

export function formatHookSelectionMessage(
  session: PipelineSession,
  hooks: Array<{ hook: string; score: number; technique: string }>,
): string {
  const lines: string[] = [
    `🪝 <b>Step 3: Select a Hook</b>`,
    `Article: <i>${esc(session.selectedArticle!.item.title.slice(0, 50))}…</i>`,
    `Type: <b>${session.selectedType}</b>`,
    '',
  ];

  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    lines.push(
      `<b>${i + 1}.</b> ${esc(h.hook)}`,
      `   <i>${esc(h.technique)} (${h.score}/10)</i>`,
      '',
    );
  }

  return lines.join('\n');
}

export function buildHookKeyboard(session: PipelineSession, hookCount: number) {
  const row1 = Array.from({ length: Math.min(hookCount, 5) }, (_, i) => ({
    text: String(i + 1),
    callback_data: `pv2_hook:${session.id}:${i}`,
  }));

  return {
    inline_keyboard: [
      row1,
      [
        { text: '🔄 Regenerate', callback_data: `pv2_hook_regen:${session.id}` },
        { text: '📰 New Article', callback_data: `pv2_hook_back:${session.id}` },
        { text: '✖ Exit', callback_data: `pv2_exit:${session.id}` },
      ],
    ],
  };
}

// ── Callback Handler ─────────────────────────────────────────────────

export async function handlePipelineV2Callback(ctx: any, data: string): Promise<void> {
    const parts = data.split(':');
    const action = parts[0];
    const sessionId = parts[1];
    const param = parts[2];

    const session = getSession(sessionId);
    if (!session) {
      await ctx.answerCbQuery('Session expired').catch(() => {});
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      await ctx.reply('Session expired — run /generate to start a new pipeline.').catch(() => {});
      return;
    }

    try {
      // ── Step 1 callbacks ──
      if (action === 'pv2_art') {
        const idx = parseInt(param);
        await ctx.answerCbQuery(`Selected article ${idx + 1}`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const candidate = selectArticle(session, idx);

        // Fetch full article text
        console.log(`[pipeline-v2] Fetching article: "${candidate.item.title.slice(0, 50)}..."`);
        await fetchArticleForCandidate(candidate);

        // Generate type options
        console.log('[pipeline-v2] Generating post-type options...');
        const balanceMultipliers = getTypeBalanceMultipliers();
        await generateTypeOptions(session, balanceMultipliers);

        // Send Step 2
        const msg = formatTypeSelectionMessage(session);
        await ctx.reply(msg, {
          parse_mode: 'HTML',
          reply_markup: buildTypeKeyboard(session),
        });
        return;
      }

      if (action === 'pv2_art_next') {
        const hasMore = nextArticlePage(session);
        if (!hasMore) {
          await ctx.answerCbQuery('No more articles.');
          return;
        }
        await ctx.answerCbQuery('Loading next 5...');
        const articles = getArticlePage(session);
        await ctx.editMessageText(formatArticleSelectionMessage(articles), {
          parse_mode: 'HTML',
          reply_markup: buildArticleKeyboard(session, articles),
        });
        return;
      }

      // ── Step 2 callbacks ──
      if (action === 'pv2_type') {
        const idx = parseInt(param);
        selectType(session, idx);
        await ctx.answerCbQuery(`Selected: ${session.selectedType}`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        // Generate hooks
        console.log(`[pipeline-v2] Generating hooks for ${session.selectedType}...`);
        const candidate = session.selectedArticle!;
        const articleText = candidate.item.fullText ?? candidate.item.summary ?? '';

        let hooks = await generateHookCandidates(candidate.item, session.selectedType!);

        // Screen hooks
        console.log(`[pipeline-v2] Screening ${hooks.length} hooks...`);
        hooks = await screenHookCandidates(hooks, candidate.item.title, articleText);
        session.hooks = hooks;

        // Send Step 3
        const msg = formatHookSelectionMessage(session, hooks);
        await ctx.reply(msg, {
          parse_mode: 'HTML',
          reply_markup: buildHookKeyboard(session, hooks.length),
        });
        return;
      }

      if (action === 'pv2_type_back') {
        backToArticleSelection(session);
        await ctx.answerCbQuery('Back to article selection');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const articles = getArticlePage(session);
        await ctx.reply(formatArticleSelectionMessage(articles), {
          parse_mode: 'HTML',
          reply_markup: buildArticleKeyboard(session, articles),
        });
        return;
      }

      // ── Step 3 callbacks ──
      if (action === 'pv2_hook') {
        const idx = parseInt(param);
        const hook = session.hooks![idx];
        selectHook(session, hook.hook);
        await ctx.answerCbQuery('Hook selected');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        // Step 4: Generate the post
        await ctx.reply('Generating post draft...').catch(() => {});
        const content = await generatePost(session);
        const cleanDisplay = content.replace(/\[\[MENTION:([^\]]+)\]\]/g, '<b>$1</b>');

        await ctx.reply(
          `📝 <b>Step 4: Review Post</b>\n` +
          `Type: <b>${session.selectedType}</b> | Angle: <i>${esc(session.selectedAngle ?? '')}</i>\n\n` +
          cleanDisplay,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Approve text', callback_data: `pv2_post_approve:${session.id}` },
                  { text: '✏ Edit', callback_data: `pv2_post_edit:${session.id}` },
                ],
                [
                  { text: '🔄 Rewrite', callback_data: `pv2_post_rewrite:${session.id}` },
                  { text: '❌ Reject', callback_data: `pv2_post_reject:${session.id}` },
                  { text: '✖ Cancel', callback_data: `pv2_exit:${session.id}` },
                ],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_hook_regen') {
        session.hookRegenCount++;
        if (session.hookRegenCount > 3) {
          await ctx.answerCbQuery('Max regenerations reached.');
          return;
        }
        await ctx.answerCbQuery('Regenerating hooks...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const candidate = session.selectedArticle!;
        const articleText = candidate.item.fullText ?? candidate.item.summary ?? '';
        const previousHooks = (session.hooks ?? []).map(h => h.hook);

        let hooks = await generateHookCandidates(candidate.item, session.selectedType!);
        // Filter out previously shown hooks
        const prevSet = new Set(previousHooks.map(h => h.toLowerCase()));
        hooks = hooks.filter(h => !prevSet.has(h.hook.toLowerCase()));
        hooks = await screenHookCandidates(hooks, candidate.item.title, articleText);
        session.hooks = hooks;

        const msg = formatHookSelectionMessage(session, hooks);
        await ctx.reply(msg, {
          parse_mode: 'HTML',
          reply_markup: buildHookKeyboard(session, hooks.length),
        });
        return;
      }

      if (action === 'pv2_hook_back') {
        backToArticleFromHook(session);
        await ctx.answerCbQuery('Back to article selection');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const articles = getArticlePage(session);
        await ctx.reply(formatArticleSelectionMessage(articles), {
          parse_mode: 'HTML',
          reply_markup: buildArticleKeyboard(session, articles),
        });
        return;
      }

      // ── Step 4 callbacks ──
      if (action === 'pv2_post_approve') {
        approvePostText(session);
        await ctx.answerCbQuery('Text approved');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        // Step 5: Generate comments
        await ctx.reply('Generating first comment & loopback...').catch(() => {});
        const { firstComment, loopbackComment } = await generateComments(session);

        await ctx.reply(
          `💬 <b>Step 5: Review Comments</b>\n\n` +
          `<b>First comment:</b>\n${esc(firstComment)}\n\n` +
          `---\n\n` +
          `<b>Loopback comment</b> <i>(next morning if no engagement):</i>\n${esc(loopbackComment)}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Accept', callback_data: `pv2_comm_approve:${session.id}` },
                  { text: '✏ Edit', callback_data: `pv2_comm_edit:${session.id}` },
                ],
                [
                  { text: '🔄 Rewrite 1st', callback_data: `pv2_comm_regen_first:${session.id}` },
                  { text: '🔄 Rewrite loop', callback_data: `pv2_comm_regen_loop:${session.id}` },
                ],
                [{ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` }],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_post_edit') {
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        // Send raw content for copy-paste editing
        const rawContent = session.generatedContent!.replace(/\[\[MENTION:([^\]]+)\]\]/g, '$1');
        await ctx.reply(rawContent);
        await ctx.reply('Send your edited version. The system will use it as the new post text.', {
          reply_markup: { inline_keyboard: [[{ text: '✖ Cancel edit', callback_data: `pv2_post_cancel_edit:${session.id}` }]] },
        });
        // Store edit state — the text message handler in telegram.ts will need to pick this up
        session.step = 'post_editing' as any;
        return;
      }

      if (action === 'pv2_post_cancel_edit') {
        session.step = 'post';
        await ctx.answerCbQuery('Edit cancelled');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return;
      }

      if (action === 'pv2_post_rewrite') {
        await ctx.answerCbQuery('Rewriting post from scratch...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const content = await generatePost(session);
        const cleanDisplay = content.replace(/\[\[MENTION:([^\]]+)\]\]/g, '<b>$1</b>');

        await ctx.reply(
          `📝 <b>Step 4: Review Post (rewrite)</b>\n` +
          `Type: <b>${session.selectedType}</b>\n\n` +
          cleanDisplay,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Approve text', callback_data: `pv2_post_approve:${session.id}` },
                  { text: '✏ Edit', callback_data: `pv2_post_edit:${session.id}` },
                ],
                [
                  { text: '🔄 Rewrite', callback_data: `pv2_post_rewrite:${session.id}` },
                  { text: '❌ Reject', callback_data: `pv2_post_reject:${session.id}` },
                  { text: '✖ Cancel', callback_data: `pv2_exit:${session.id}` },
                ],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_post_reject') {
        await ctx.answerCbQuery();
        await ctx.editMessageText('Are you sure you want to reject this post and return to article selection?', {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Yes, reject', callback_data: `pv2_post_reject_confirm:${session.id}` },
                { text: '↩ No, go back', callback_data: `pv2_post_reject_cancel:${session.id}` },
              ],
            ],
          },
        });
        return;
      }

      if (action === 'pv2_post_reject_confirm') {
        backToArticleFromPost(session);
        await ctx.answerCbQuery('Post rejected — back to articles');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const articles = getArticlePage(session);
        await ctx.reply(formatArticleSelectionMessage(articles), {
          parse_mode: 'HTML',
          reply_markup: buildArticleKeyboard(session, articles),
        });
        return;
      }

      if (action === 'pv2_post_reject_cancel') {
        await ctx.answerCbQuery('Rejection cancelled');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return;
      }

      // ── Step 5 callbacks ──
      if (action === 'pv2_comm_approve') {
        approveComments(session);
        await ctx.answerCbQuery('Comments approved');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        // Step 6: Mentions
        await ctx.reply('Processing mentions...').catch(() => {});
        const newMentions = await processMentions(session);
        const displayContent = session.generatedContent!.replace(/\[\[MENTION:([^\]]+)\]\]/g, '<b>@$1</b>');

        const mentionNote = newMentions.length > 0
          ? `\n\n<b>New unverified mentions:</b> ${newMentions.join(', ')}\nRun <code>npm run test-mentions</code> to verify, then tap "Recheck" below.`
          : '\n\nAll mentions are verified.';

        await ctx.reply(
          `🔗 <b>Step 6: Confirm Full Text & Mentions</b>\n\n` +
          displayContent +
          `\n\n<b>First comment:</b> ${esc(session.firstComment ?? '')}` +
          `\n<b>Loopback:</b> ${esc(session.loopbackComment ?? '')}` +
          mentionNote,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Confirm & continue', callback_data: `pv2_mentions_confirm:${session.id}` },
                  { text: '🔄 Recheck mentions', callback_data: `pv2_mentions_recheck:${session.id}` },
                ],
                [{ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` }],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_comm_regen_first') {
        await ctx.answerCbQuery('Regenerating first comment...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const { synthesizeFirstComment } = await import('../content/synthesize-comments.js');
        const firstComment = await synthesizeFirstComment(session.generatedContent!);
        session.firstComment = firstComment;

        await ctx.reply(
          `💬 <b>Step 5: Review Comments</b>\n\n` +
          `<b>First comment:</b>\n${esc(firstComment)}\n\n---\n\n` +
          `<b>Loopback comment:</b>\n${esc(session.loopbackComment ?? '')}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Accept', callback_data: `pv2_comm_approve:${session.id}` }, { text: '✏ Edit', callback_data: `pv2_comm_edit:${session.id}` }],
                [{ text: '🔄 Rewrite 1st', callback_data: `pv2_comm_regen_first:${session.id}` }, { text: '🔄 Rewrite loop', callback_data: `pv2_comm_regen_loop:${session.id}` }],
                [{ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` }],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_comm_regen_loop') {
        await ctx.answerCbQuery('Regenerating loopback...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const { synthesizeLoopbackComment } = await import('../content/synthesize-comments.js');
        const loopbackComment = await synthesizeLoopbackComment(
          session.generatedContent!, session.firstComment!, session.selectedArticle!.item,
        );
        session.loopbackComment = loopbackComment;

        await ctx.reply(
          `💬 <b>Step 5: Review Comments</b>\n\n` +
          `<b>First comment:</b>\n${esc(session.firstComment ?? '')}\n\n---\n\n` +
          `<b>Loopback comment:</b>\n${esc(loopbackComment)}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Accept', callback_data: `pv2_comm_approve:${session.id}` }, { text: '✏ Edit', callback_data: `pv2_comm_edit:${session.id}` }],
                [{ text: '🔄 Rewrite 1st', callback_data: `pv2_comm_regen_first:${session.id}` }, { text: '🔄 Rewrite loop', callback_data: `pv2_comm_regen_loop:${session.id}` }],
                [{ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` }],
              ],
            },
          },
        );
        return;
      }

      if (action === 'pv2_comm_edit') {
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        // Send editable text with --- separator
        await ctx.reply(`${session.firstComment}\n\n---\n\n${session.loopbackComment}`);
        await ctx.reply('Send your edited version. Keep the --- separator between the first comment and loopback.', {
          reply_markup: { inline_keyboard: [[{ text: '✖ Cancel edit', callback_data: `pv2_comm_cancel_edit:${session.id}` }]] },
        });
        session.step = 'comments_editing' as any;
        return;
      }

      if (action === 'pv2_comm_cancel_edit') {
        session.step = 'comments';
        await ctx.answerCbQuery('Edit cancelled');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return;
      }

      // ── Step 6 callbacks ──
      if (action === 'pv2_mentions_confirm') {
        confirmMentions(session);
        await ctx.answerCbQuery('Mentions confirmed');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        await ctx.reply('🖼 <b>Step 7: Select Image</b>\n\nGenerating image options...', { parse_mode: 'HTML' });

        // Persist the approved draft to pending_posts.json so the image
        // selection and approval callbacks can find it by id.
        const draft = {
          ...session.postDraft,
          firstComment: session.firstComment,
          loopbackComment: session.loopbackComment,
        };
        const screening = session.postDraft.screening ?? { cringeScore: 0, reasoning: '', revisedContent: null, revisedFirstComment: null };
        const post = addPendingPost(draft, screening);
        // Update finalContent with the latest from session
        const { readFileSync: readFS, writeFileSync: writeFS } = await import('fs');
        const pending = JSON.parse(readFS('pending_posts.json', 'utf-8'));
        const entry = pending.find((p: any) => p.id === post.id);
        if (entry) {
          entry.finalContent = session.generatedContent;
          writeFS('pending_posts.json', JSON.stringify(pending, null, 2));
        }
        (session as any).postId = post.id;

        // Hand off to the shared image-selection flow. This generates an AI
        // image, fetches og:image and stock options, sends previews, and
        // presents image-choice buttons. The user's choice triggers the
        // existing img_* callbacks in telegram.ts which approve the post,
        // schedule it, and send the publish reminder.
        const { startImageSelection } = await import('./telegram.js');
        startImageSelection(post.id).catch(err => {
          console.error('[pv2 image selection] Error:', err);
          ctx.reply('Failed to generate image options. Try /generate again.').catch(() => {});
        });
        return;
      }

      if (action === 'pv2_mentions_recheck') {
        await ctx.answerCbQuery('Rechecking mentions...');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

        const { injectMentionMarkers } = await import('../content/synthesize.js');
        // Strip existing markers, re-inject with any newly verified entries
        const stripped = session.generatedContent!.replace(/\[\[MENTION:([^\]]+)\]\]/g, '$1');
        session.generatedContent = injectMentionMarkers(stripped);

        const mentionCount = (session.generatedContent.match(/\[\[MENTION:/g) ?? []).length;
        console.log(`[pipeline-v2] Mentions rechecked — ${mentionCount} mention(s) injected.`);

        const displayContent = session.generatedContent.replace(/\[\[MENTION:([^\]]+)\]\]/g, '<b>@$1</b>');

        await ctx.reply(
          `🔗 <b>Step 6: Confirm Full Text & Mentions (rechecked — ${mentionCount} mention(s))</b>\n\n` +
          displayContent +
          `\n\n<b>First comment:</b> ${esc(session.firstComment ?? '')}` +
          `\n<b>Loopback:</b> ${esc(session.loopbackComment ?? '')}`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Confirm & continue', callback_data: `pv2_mentions_confirm:${session.id}` },
                  { text: '🔄 Recheck mentions', callback_data: `pv2_mentions_recheck:${session.id}` },
                ],
                [{ text: '✖ Exit', callback_data: `pv2_exit:${session.id}` }],
              ],
            },
          },
        );
        return;
      }

      // ── Global ──
      if (action === 'pv2_exit') {
        deleteSession(sessionId);
        await ctx.answerCbQuery('Pipeline cancelled.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        await ctx.reply('Pipeline cancelled.');
        return;
      }
    } catch (err) {
      console.error(`[pipeline-v2] Callback error: ${(err as Error).message}`);
      await ctx.answerCbQuery('Error occurred').catch(() => {});
      await ctx.reply(`Pipeline error: ${(err as Error).message}`).catch(() => {});
    } finally {
      // Persist session state after every callback
      if (session) {
        saveSession(session);
      }
    }
}

// ── Entry Point: Start the pipeline ──────────────────────────────────

export async function startPipelineV2(
  candidates: ScoredCandidate[],
  sendMessage: (text: string, opts?: any) => Promise<any>,
): Promise<PipelineSession> {
  const session = createSession(candidates);
  const articles = getArticlePage(session);
  const msg = formatArticleSelectionMessage(articles);

  await sendMessage(msg, {
    parse_mode: 'HTML',
    reply_markup: buildArticleKeyboard(session, articles),
  });

  return session;
}
