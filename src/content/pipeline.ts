import { fetchLatestItems, FeedItem } from './rss.js';
import { fetchNewsDataItems } from './newsdata.js';
import { fetchArticle } from './fetch-article.js';
import { synthesizePost } from './synthesize.js';
import { screenPost } from './screen.js';
import { verifyPost } from './verify.js';
import { addPendingPost, getSourceHistory, cancelPost, PendingPost } from '../hitl/queue.js';
import { notifyTelegram, notifyHookSelection, waitForHookSelection, type HookSelectionResult, type NextUpCandidate } from '../hitl/telegram.js';
import { pickPostType, PostType, POST_TYPE_WEIGHTS } from './persona.js';
import { rankItems, ScoreBreakdown, TypeFitScores } from './rank.js';
import { addUnverifiedMentions } from '../poster/mentions.js';
import { CONTENT_TAGS, ContentTag, generateHookCandidates, screenHookCandidates, injectMentionMarkers } from './synthesize.js';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const anthropic = new Anthropic();

let pipelineRunning = false;

export function isPipelineRunning(): boolean { return pipelineRunning; }

// Strip [[MENTION:X]] markers from text, returning cleaned text and the marker positions.
function stripMentionMarkers(text: string): { clean: string; markers: Array<{ name: string; plainName: string }> } {
  const markers: Array<{ name: string; plainName: string }> = [];
  const clean = text.replace(/\[\[MENTION:([^\]]+)\]\]/g, (_, name) => {
    markers.push({ name, plainName: name });
    return name;
  });
  return { clean, markers };
}

// Re-inject [[MENTION:X]] markers into revised text — first occurrence only,
// and never inside a hashtag. Longest names matched first to avoid partials.
// Re-inject [[MENTION:X]] markers into revised text — first occurrence only,
// never inside a hashtag, and never in the hook (first paragraph).
function reInjectMentionMarkers(revised: string, markers: Array<{ name: string; plainName: string }>): string {
  if (markers.length === 0) return revised;

  // Split into hook (first paragraph) and body — only inject in body
  const firstBreak = revised.indexOf('\n\n');
  const hook = firstBreak >= 0 ? revised.slice(0, firstBreak) : revised;
  const body = firstBreak >= 0 ? revised.slice(firstBreak) : '';

  const names = [...new Set(markers.map(m => m.name))].sort((a, b) => b.length - a.length);
  let result = body;
  for (const name of names) {
    const marker = `[[MENTION:${name}]]`;
    if (result.includes(marker)) continue; // already injected
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<!#)(?<!\\w)${escaped}(?!\\w)`), marker);
  }
  // Strip any markers that ended up inside hashtags (e.g. #[[MENTION:NPX]])
  result = result.replace(/#\[\[MENTION:([^\]]+)\]\]/g, '#$1');
  return hook + result;
}

export interface PipelineOptions {
  url?: string;
  topic?: string;
}

const CANDIDATES_FILE = 'candidates.json';
const CANDIDATES_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Select the best post type for an article using typeFit × softened weight.
 *
 * Raw weights range from 7 to 30 (4.3x ratio), which makes bridge win almost
 * every time. We compress the weights using sqrt so the ratio narrows to ~2x,
 * giving the LLM's fit scores meaningful influence while still favoring
 * higher-weighted types.
 *
 * sqrt(30) = 5.48, sqrt(8) = 2.83 → ratio 1.94x (vs 3.75x raw)
 * This means bridge needs roughly 2x the fit score of hot-take to win,
 * not 4x. The LLM's assessment actually matters.
 */
function selectPostType(
  typeFit: TypeFitScores,
  balanceMultipliers: Partial<Record<PostType, number>>,
  lastPostType?: PostType,
): PostType {
  // If no type has a fit score >= 4, the article doesn't strongly match any type.
  // Fall back to weighted random selection instead of letting bridge win by default.
  const maxFit = Math.max(...Object.values(typeFit).map(v => v ?? 0));
  if (maxFit < 4) {
    return pickPostType(lastPostType);
  }

  let bestType: PostType = 'bridge';
  let bestScore = -1;

  for (const [type, weight] of Object.entries(POST_TYPE_WEIGHTS) as [PostType, number][]) {
    if (weight == null) continue;
    const fit = typeFit[type] ?? 0;
    const balance = balanceMultipliers[type] ?? 1.0;
    // Soften weights with sqrt to prevent bridge from dominating
    const score = fit * Math.sqrt(weight) * balance;
    // Slight penalty for repeating last post type
    const adjusted = (type === lastPostType) ? score * 0.7 : score;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      bestType = type;
    }
  }

  return bestType;
}

interface ScoredCandidate {
  item: FeedItem;
  postType: PostType;
  articleScore: number;
  scoreBreakdown: ScoreBreakdown;
  balanceMultiplier: number;
  recencyMultiplier: number;
  postContentFeedback: number;
  combinedScore: number;
  reasoning: string;
}

interface CandidateStore {
  generatedAt: string;
  nextIndex: number;
  candidates: ScoredCandidate[];
}

function loadCandidateStore(): CandidateStore | null {
  if (!existsSync(CANDIDATES_FILE)) return null;
  try {
    const store = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf-8')) as CandidateStore;
    if (Date.now() - new Date(store.generatedAt).getTime() > CANDIDATES_TTL_MS) return null;
    return store;
  } catch {
    return null;
  }
}

export function clearCandidateStore(): void {
  if (existsSync(CANDIDATES_FILE)) unlinkSync(CANDIDATES_FILE);
}

function getRecentTitles(limit = 10): string[] {
  if (!existsSync('posted_history.json')) return [];
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    return history.slice(-limit).map((p: any) => p.draft?.sourceTitle ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

function getLastPostType(): PostType | undefined {
  if (!existsSync('posted_history.json')) return undefined;
  try {
    const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
    if (history.length === 0) return undefined;
    return history[history.length - 1].draft?.postType;
  } catch {
    return undefined;
  }
}

// Returns a balance multiplier (0-2) for each post type based on how underused
// it is relative to its target weight across recent posts.
// Types used less than their target share score above 1.0 (boosted).
// Types used more than their target share score below 1.0 (suppressed).
function getTypeBalanceMultipliers(lookback = 14): Partial<Record<PostType, number>> {
  const weights = POST_TYPE_WEIGHTS;
  const totalWeight = Object.values(weights).filter((w): w is number => w != null).reduce((a, b) => a + b, 0);

  const counts: Record<string, number> = {};
  for (const type of Object.keys(weights)) counts[type] = 0;

  if (existsSync('posted_history.json')) {
    try {
      const history = JSON.parse(readFileSync('posted_history.json', 'utf-8'));
      history.slice(-lookback).forEach((p: any) => {
        const t = p.draft?.postType;
        if (t && t in counts) counts[t]++;
      });
    } catch {}
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const multipliers: Record<string, number> = {};

  for (const [type, weight] of Object.entries(weights).filter(([, w]) => w != null) as [string, number][]) {
    const targetShare = weight / totalWeight;
    const actualShare = total > 0 ? (counts[type] ?? 0) / total : 0;
    // Clamp between 0.8 and 1.2 — article quality should dominate, balance is a light nudge
    multipliers[type] = Math.min(1.2, Math.max(0.8, targetShare / Math.max(actualShare, 0.01)));
  }

  return multipliers as Record<PostType, number>;
}

// Tag scoring and post-content feedback now use the analytics module
// with confidence-weighted scoring instead of naive averages.
import { getConfidenceWeightedTagScores } from '../analytics/feedback.js';


async function generateContentTags(content: string): Promise<ContentTag[]> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Tag this LinkedIn post with all relevant labels from the list below. Apply as many as genuinely fit — there is no upper limit, but do not force tags that are only loosely related. Return ONLY a valid JSON array of strings using exact values from the list — no other text.\n\nAllowed tags: ${CONTENT_TAGS.join(', ')}\n\nPost:\n${content}`,
      }],
    });
    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('Content tagger returned no JSON array — skipping tags.');
      return [];
    }
    const tags = JSON.parse(match[0]) as string[];
    return tags.filter((t): t is ContentTag => (CONTENT_TAGS as readonly string[]).includes(t));
  } catch (err: any) {
    console.warn('Content tagging failed:', err?.message ?? err);
    return [];
  }
}

async function extractAndRegisterMentions(content: string): Promise<void> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract all company, organization, and institution names from this text. Include acronyms that refer to specific organizations. Exclude: generic terms, people's names, hashtags, and post types. Return ONLY a valid JSON array of strings, no other text.\n\nText:\n${content}`,
      }],
    });
    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('Mention extractor returned no JSON array — skipping.');
      return;
    }
    const names = JSON.parse(match[0]) as string[];
    addUnverifiedMentions(names);
  } catch {
    // Non-critical — don't block the pipeline
  }
}

async function finalize(item: FeedItem, postType: PostType, combinedScore?: number, scoreBreakdown?: ScoreBreakdown, multipliers?: { balance: number; recency: number; postContent: number }, selectedHook?: string): Promise<PendingPost> {
  console.log(`Post type: ${postType}`);

  console.log('Synthesizing draft...');
  let draft = await synthesizePost(item, postType, selectedHook);
  if (combinedScore !== undefined) draft = { ...draft, combinedScore };
  if (scoreBreakdown !== undefined) draft = { ...draft, scoreBreakdown };
  if (multipliers !== undefined) draft = { ...draft, balanceMultiplier: multipliers.balance, recencyMultiplier: multipliers.recency, postContentFeedback: multipliers.postContent };
  if (item.fullText) draft = { ...draft, articleFullText: item.fullText };

  // Strip [[MENTION:X]] markers before passing to verifier/screener so they
  // see clean prose. Markers are re-injected into any revised output afterward.
  const { clean: cleanContent, markers } = stripMentionMarkers(draft.content);

  const verificationSource = item.fullText ?? item.summary;
  if (verificationSource) {
    console.log(`Verifying factual claims${item.fullText ? '' : ' (using summary only — full text unavailable)'}...`);
    const verification = await verifyPost(cleanContent, verificationSource);
    if (verification.changed) {
      console.log(`Verifier corrected ${verification.flaggedClaims.length} claim(s):`);
      for (const claim of verification.flaggedClaims) console.log(`  - ${claim}`);
      draft = { ...draft, content: reInjectMentionMarkers(verification.correctedContent, markers) };
    } else {
      console.log('Verification passed — no corrections needed.');
      draft = { ...draft, content: reInjectMentionMarkers(cleanContent, markers) };
    }
  }

  console.log('Running screening agent...');
  const screeningDraft = { ...draft, content: stripMentionMarkers(draft.content).clean };
  const screening = await screenPost(screeningDraft);

  console.log(`Cringe score: ${screening.cringeScore}/10 — ${screening.reasoning}`);
  if (screening.cringeScore > 3 && screening.revisedContent) {
    // Re-inject markers into the screener's revised content
    screening.revisedContent = reInjectMentionMarkers(screening.revisedContent, markers);
    console.log('Auto-revised by screener.');
  }

  // Lock the selected hook — restore it as the first line if the verifier/screener changed it.
  // The hook was already fact-checked and screened during hook selection, so it's safe.
  if (selectedHook) {
    const restoreHook = (text: string): string => {
      const firstBreak = text.indexOf('\n\n');
      if (firstBreak < 0) return text;
      const currentHook = text.slice(0, firstBreak);
      if (currentHook !== selectedHook) {
        console.log(`[hook-lock] Restoring selected hook (was modified to: "${currentHook.slice(0, 60)}...")`);
        return selectedHook + text.slice(firstBreak);
      }
      return text;
    };
    draft = { ...draft, content: injectMentionMarkers(restoreHook(draft.content)) };
    if (screening.revisedContent) {
      screening.revisedContent = injectMentionMarkers(restoreHook(screening.revisedContent));
    }
  }

  // Tag the final content and store on draft before saving
  const contentTags = await generateContentTags(stripMentionMarkers(draft.content).clean);
  if (contentTags.length > 0) {
    draft = { ...draft, contentTags };
    console.log(`Content tags: ${contentTags.join(', ')}`);
  }

  // Image generation is deferred to Step 2 (after text approval) — not done here.

  const post = addPendingPost(draft, screening);
  console.log(`Draft saved as ID: ${post.id}`);

  // Extract and register any company names not yet in the mentions dictionary
  await extractAndRegisterMentions(post.finalContent);

  try {
    await notifyTelegram(post);
  } catch (err: any) {
    console.error(`Telegram notification failed (post saved as ${post.id}): ${err?.message ?? err}`);
    console.log('Post was saved — approve/reject via /generate or CLI.');
  }
  console.log('Done. Awaiting your approval.');

  return post;
}

// Fetch article text for a candidate (shared by interactive and non-interactive paths).
async function fetchArticleForCandidate(candidate: ScoredCandidate): Promise<void> {
  console.log(`Selected: "${candidate.item.title}" (${candidate.item.source})`);
  const bd = candidate.scoreBreakdown;
  console.log(`Score: ${candidate.articleScore}/10 (I:${bd.intersection} N:${bd.novelty} G:${bd.geography} NPX:${bd.npx}) — ${candidate.reasoning}`);
  console.log(`Balance: ${candidate.balanceMultiplier.toFixed(2)}x | Recency: ${candidate.recencyMultiplier.toFixed(2)}x | Post-content feedback: ${candidate.postContentFeedback.toFixed(2)}x | Combined: ${candidate.combinedScore.toFixed(2)}`);
  console.log(`Post type: ${candidate.postType}`);

  if (candidate.item.link && (!candidate.item.fullText || !candidate.item.imageUrl)) {
    try {
      console.log('Fetching full article text...');
      const fetched = await fetchArticle(candidate.item.link);
      if (fetched.fullText) candidate.item.fullText = fetched.fullText;
      if (fetched.imageUrl) {
        candidate.item.imageUrl = fetched.imageUrl;
        console.log(`Image found: ${fetched.imageUrl}`);
      } else {
        console.log('No og:image found on article page.');
      }
    } catch {
      console.warn('Could not fetch full article text — will use RSS summary only.');
    }
  }
}

// Generate a 1-2 sentence article summary for the hook selection message.
async function generateArticleSummary(item: FeedItem): Promise<string> {
  try {
    const snippet = item.fullText
      ? item.fullText.split(/\s+/).slice(0, 200).join(' ')
      : item.summary?.slice(0, 400) ?? '';
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Summarize this article in 1-2 sentences (under 40 words). Be specific — include key names, numbers, and outcomes.\n\nTitle: ${item.title}\n\n${snippet}`,
      }],
    });
    return response.content[0].type === 'text' ? response.content[0].text.trim() : item.title;
  } catch {
    return item.summary?.slice(0, 200) ?? item.title;
  }
}

// Interactive path: show hooks to user, wait for selection, then finalize.
async function interactiveHookSelection(
  candidates: ScoredCandidate[],
  startIndex: number,
  store: CandidateStore,
): Promise<PendingPost | null> {
  const { excludedUrls, excludedTitles } = getSourceHistory();

  for (let idx = startIndex; idx < candidates.length; idx++) {
    const candidate = candidates[idx];

    // Skip already-used articles
    if (candidate.item.link && excludedUrls.includes(candidate.item.link)) continue;
    if (excludedTitles.some(t => t.toLowerCase() === candidate.item.title.toLowerCase())) continue;

    // Fetch article and generate hooks
    await fetchArticleForCandidate(candidate);

    const articleText = candidate.item.fullText ?? candidate.item.summary ?? '';
    const summary = await generateArticleSummary(candidate.item);
    const nextUp: NextUpCandidate[] = candidates
      .slice(idx + 1, idx + 4)
      .filter(c => !excludedUrls.includes(c.item.link) && !excludedTitles.some(t => t.toLowerCase() === c.item.title.toLowerCase()))
      .slice(0, 3)
      .map(c => ({ title: c.item.title, combinedScore: c.combinedScore, postType: c.postType }));

    // Hook generation + selection loop (allows regeneration)
    const allPreviousHooks: string[] = [];
    const MAX_REGEN_ROUNDS = 3;

    for (let regenRound = 0; regenRound < MAX_REGEN_ROUNDS; regenRound++) {
      console.log(regenRound === 0 ? 'Generating hook candidates...' : `Regenerating hooks (round ${regenRound + 1})...`);
      let hooks = await generateHookCandidates(candidate.item, candidate.postType);

      // Remove any hooks we've already shown
      if (allPreviousHooks.length > 0) {
        const prevSet = new Set(allPreviousHooks.map(h => h.toLowerCase()));
        hooks = hooks.filter(h => !prevSet.has(h.hook.toLowerCase()));
      }

      // Screen hooks and backfill if any are dropped — always aim for 5
      const TARGET_HOOKS = 5;
      const MAX_BACKFILL_ROUNDS = 2;
      let backfillRound = 0;

      while (hooks.length > 0 && backfillRound <= MAX_BACKFILL_ROUNDS) {
        console.log(`Screening ${hooks.length} hook(s) for factual accuracy...`);
        hooks = await screenHookCandidates(hooks, candidate.item.title, articleText);

        if (hooks.length >= TARGET_HOOKS) break;
        if (backfillRound >= MAX_BACKFILL_ROUNDS) break;

        const needed = TARGET_HOOKS - hooks.length;
        console.log(`${hooks.length} hook(s) passed — generating ${needed} replacement(s)...`);
        backfillRound++;
        const extra = await generateHookCandidates(candidate.item, candidate.postType);
        const existingTexts = new Set([...hooks.map(h => h.hook.toLowerCase()), ...allPreviousHooks.map(h => h.toLowerCase())]);
        const newHooks = extra.filter(h => !existingTexts.has(h.hook.toLowerCase())).slice(0, needed);
        hooks = [...hooks, ...newHooks];
      }

      if (hooks.length === 0) {
        console.warn('No hooks survived screening — skipping to next article.');
        break;
      }

      hooks = hooks.slice(0, TARGET_HOOKS);
      allPreviousHooks.push(...hooks.map(h => h.hook));
      console.log(`${hooks.length} hook(s) ready. Sending to Telegram for selection...`);

      const sessionId = `hk_${Date.now()}`;

      await notifyHookSelection(sessionId, {
        title: candidate.item.title,
        link: candidate.item.link,
        summary,
        score: candidate.combinedScore,
        scoreBreakdown: candidate.scoreBreakdown,
        postType: candidate.postType,
        balanceMultiplier: candidate.balanceMultiplier,
        recencyMultiplier: candidate.recencyMultiplier,
        postContentFeedback: candidate.postContentFeedback,
      }, hooks, nextUp);

      const result: HookSelectionResult = await waitForHookSelection(sessionId, hooks, candidate.item.title);

      if (result.action === 'exit') {
        writeFileSync(CANDIDATES_FILE, JSON.stringify({ ...store, nextIndex: idx }, null, 2));
        console.log('[hook-selection] User exited pipeline.');
        return null;
      }

      if (result.action === 'skip') {
        writeFileSync(CANDIDATES_FILE, JSON.stringify({ ...store, nextIndex: idx + 1 }, null, 2));
        console.log(`[hook-selection] Skipping "${candidate.item.title.slice(0, 50)}"...`);
        break; // break inner loop, continue outer article loop
      }

      if (result.action === 'regenerate') {
        console.log('[hook-selection] Regenerating hooks...');
        continue; // continue inner regen loop
      }

      // Hook selected — advance pointer and finalize
      writeFileSync(CANDIDATES_FILE, JSON.stringify({ ...store, nextIndex: idx + 1 }, null, 2));
      console.log(`[hook-selection] Proceeding with hook: "${result.selectedHook?.slice(0, 60)}..."`);
      return finalize(candidate.item, candidate.postType, candidate.combinedScore, candidate.scoreBreakdown,
        { balance: candidate.balanceMultiplier, recency: candidate.recencyMultiplier, postContent: candidate.postContentFeedback },
        result.selectedHook);
    }
  }

  console.log('[hook-selection] All candidates exhausted.');
  return null;
}

// Re-runs synthesis for an existing post — same article, same post type, fresh hooks/text/screening.
export async function rewritePost(post: PendingPost): Promise<PendingPost> {
  if (pipelineRunning) {
    throw new Error('Pipeline already in progress — concurrent calls are not allowed.');
  }
  pipelineRunning = true;
  try {
    console.log(`Rewriting post ${post.id} — "${post.draft.sourceTitle}"`);

    // Reconstruct the FeedItem from the stored draft
    const isInsider = post.draft.postType === 'insider';
    const item: FeedItem = {
      title: post.draft.sourceTitle,
      link: post.draft.sourceUrl,
      summary: isInsider ? (post.draft.articleFullText ?? post.finalContent).slice(0, 400) : '',
      source: post.draft.sourceFeed ?? post.draft.sourceTitle,
      pubDate: post.draft.sourceDate,
      fullText: undefined,
      imageUrl: post.draft.imageUrl,
    };

    if (isInsider) {
      // Insider rewrites use the original notes (cached as articleFullText), not the generated post
      if (post.draft.articleFullText) {
        item.fullText = post.draft.articleFullText;
        console.log('Using cached daily notes for insider rewrite.');
      } else {
        // Fallback: use the generated post content as source (not ideal but better than nothing)
        console.warn('No cached notes found — using generated post content as source.');
        item.fullText = post.finalContent;
      }
    } else {
      // Re-fetch full article text if we have a URL
      if (item.link) {
        try {
          console.log('Re-fetching full article text...');
          const fetched = await fetchArticle(item.link);
          if (fetched.fullText) item.fullText = fetched.fullText;
          if (fetched.imageUrl) item.imageUrl = fetched.imageUrl;
        } catch {
          console.warn('Could not fetch full article text.');
        }
      }

      // Fall back to cached article text from original generation if re-fetch failed
      if (!item.fullText && post.draft.articleFullText) {
        console.log('Using cached article text from original generation.');
        item.fullText = post.draft.articleFullText;
      }
    }

    // Cancel the old post
    cancelPost(post.id);
    console.log(`Old post ${post.id} cancelled.`);

    // Preserve the selected hook from the original post — it was already approved by the user
    const existingContent = post.finalContent ?? post.draft.content;
    const firstBreak = existingContent.indexOf('\n\n');
    const lockedHook = firstBreak >= 0 ? existingContent.slice(0, firstBreak).replace(/\[\[MENTION:[^\]]+\]\]/g, m => m.replace(/\[\[MENTION:|\]\]/g, '')) : undefined;
    if (lockedHook) {
      console.log(`Locking hook: "${lockedHook.slice(0, 60)}..."`);
    }

    const postType = post.draft.postType as PostType;
    return await finalize(item, postType, post.draft.combinedScore, post.draft.scoreBreakdown,
      post.draft.balanceMultiplier !== undefined ? {
        balance: post.draft.balanceMultiplier,
        recency: post.draft.recencyMultiplier ?? 1,
        postContent: post.draft.postContentFeedback ?? 1,
      } : undefined,
      lockedHook);
  } finally {
    pipelineRunning = false;
  }
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PendingPost | null> {
  if (pipelineRunning) {
    throw new Error('Pipeline already in progress — concurrent calls are not allowed.');
  }
  pipelineRunning = true;
  try {
  return await _runPipeline(options);
  } finally {
    pipelineRunning = false;
  }
}

// Runs the pipeline for an insider post using accumulated daily notes.
export async function runInsiderPipeline(assembledNotes: string): Promise<PendingPost | null> {
  if (pipelineRunning) {
    throw new Error('Pipeline already in progress — concurrent calls are not allowed.');
  }
  pipelineRunning = true;
  try {
    console.log('[insider] Generating insider post from daily notes...');

    // Search notes for friction points to ground the hook
    const frictionPattern = /friction|frustrat|block|stuck|broke|fail|conflict|struggle|challeng|problem|bug|error|workaround/i;
    const noteLines = assembledNotes.split('\n\n');
    const frictionNotes = noteLines.filter(line => frictionPattern.test(line));
    const frictionHint = frictionNotes.length > 0
      ? `\n\nWEEKLY FRICTION POINTS (ground your hook in one of these):\n${frictionNotes.join('\n')}`
      : '';

    const item: FeedItem = {
      title: 'Weekly insider observations from NPX',
      link: '',
      summary: assembledNotes.slice(0, 400),
      fullText: assembledNotes + frictionHint,
      source: 'Daily Notes',
      pubDate: new Date().toISOString(),
    };

    // Interactive hook selection for insider posts (with regeneration)
    const articleText = item.fullText ?? item.summary ?? '';
    const summary = 'Weekly insider dispatch from NPX — firsthand observations from building AI tools for the nuclear sector.';
    const allPreviousHooks: string[] = [];
    const MAX_REGEN_ROUNDS = 3;

    for (let regenRound = 0; regenRound < MAX_REGEN_ROUNDS; regenRound++) {
      console.log(regenRound === 0 ? '[insider] Generating hook candidates...' : `[insider] Regenerating hooks (round ${regenRound + 1})...`);
      let hooks = await generateHookCandidates(item, 'insider');

      // Remove previously shown hooks
      if (allPreviousHooks.length > 0) {
        const prevSet = new Set(allPreviousHooks.map(h => h.toLowerCase()));
        hooks = hooks.filter(h => !prevSet.has(h.hook.toLowerCase()));
      }

      const TARGET_HOOKS = 5;
      const MAX_BACKFILL_ROUNDS = 2;
      let backfillRound = 0;

      while (hooks.length > 0 && backfillRound <= MAX_BACKFILL_ROUNDS) {
        console.log(`[insider] Screening ${hooks.length} hook(s) for factual accuracy...`);
        hooks = await screenHookCandidates(hooks, item.title, articleText);

        if (hooks.length >= TARGET_HOOKS) break;
        if (backfillRound >= MAX_BACKFILL_ROUNDS) break;

        const needed = TARGET_HOOKS - hooks.length;
        console.log(`[insider] ${hooks.length} hook(s) passed — generating ${needed} replacement(s)...`);
        backfillRound++;
        const extra = await generateHookCandidates(item, 'insider');
        const existingTexts = new Set([...hooks.map(h => h.hook.toLowerCase()), ...allPreviousHooks.map(h => h.toLowerCase())]);
        const newHooks = extra.filter(h => !existingTexts.has(h.hook.toLowerCase())).slice(0, needed);
        hooks = [...hooks, ...newHooks];
      }

      if (hooks.length === 0) {
        if (regenRound === 0) {
          console.warn('[insider] No hooks survived screening — falling back to auto-generation.');
          return await finalize(item, 'insider');
        }
        console.warn('[insider] No more unique hooks available.');
        return null;
      }

      hooks = hooks.slice(0, TARGET_HOOKS);
      allPreviousHooks.push(...hooks.map(h => h.hook));
      console.log(`[insider] ${hooks.length} hook(s) ready. Sending to Telegram for selection...`);

      const sessionId = `hk_${Date.now()}`;

      await notifyHookSelection(sessionId, {
        title: item.title,
        link: '',
        summary,
        score: 0,
        scoreBreakdown: { intersection: 0, novelty: 0, geography: 0, npx: 1 },
        postType: 'insider',
        balanceMultiplier: 1,
        recencyMultiplier: 1,
        postContentFeedback: 1,
      }, hooks, []);

      const result: HookSelectionResult = await waitForHookSelection(sessionId, hooks, item.title);

      if (result.action === 'exit') {
        console.log('[insider] User exited pipeline.');
        return null;
      }

      if (result.action === 'skip') {
        console.log('[insider] User skipped — no alternative articles for insider posts.');
        return null;
      }

      if (result.action === 'regenerate') {
        console.log('[insider] Regenerating hooks...');
        continue;
      }

      console.log(`[insider] Proceeding with hook: "${result.selectedHook?.slice(0, 60)}..."`);
      return await finalize(item, 'insider', undefined, undefined, undefined, result.selectedHook);
    }

    console.log('[insider] Max regeneration rounds reached.');
    return null;
  } finally {
    pipelineRunning = false;
  }
}

async function _runPipeline(options: PipelineOptions = {}): Promise<PendingPost | null> {
  const lastPostType = getLastPostType();

  if (options.url) {
    console.log(`Fetching article from URL: ${options.url}`);
    const item = await fetchArticle(options.url);
    console.log(`Using: "${item.title}" (${item.source})`);
    return finalize(item, pickPostType(lastPostType));
  }

  if (options.topic) {
    console.log(`Using manual topic: "${options.topic}"`);
    const item: FeedItem = {
      title: options.topic,
      link: '',
      summary: options.topic,
      source: 'Manual',
      pubDate: new Date().toISOString(),
    };
    return finalize(item, pickPostType(lastPostType));
  }

  // --- Use cached candidates if available and fresh ---
  let store = loadCandidateStore();
  if (store && store.nextIndex < store.candidates.length) {
    console.log(`Using cached candidates (${store.candidates.length} total, starting at ${store.nextIndex})`);
    const result = await interactiveHookSelection(store.candidates, store.nextIndex, store);
    if (result) return result;

    console.log('All cached candidates exhausted or skipped — fetching fresh articles...');
  }

  // --- Fresh fetch + rank + score ---
  console.log('Fetching RSS feeds...');
  const rssItems = await fetchLatestItems();

  console.log('Fetching NewsData articles...');
  const newsDataItems = await fetchNewsDataItems();

  // Merge and deduplicate by URL
  const seenUrls = new Set<string>();
  const items: FeedItem[] = [];
  for (const item of [...rssItems, ...newsDataItems]) {
    const key = item.link.replace(/\/$/, '').toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    items.push(item);
  }
  console.log(`Total articles: ${items.length} (${rssItems.length} RSS + ${newsDataItems.length} NewsData, ${rssItems.length + newsDataItems.length - items.length} duplicates removed)`);

  // Lightweight keyword pre-filter — drop articles with zero relevance keywords in title + summary
  const RELEVANCE_KEYWORDS = [
    'nuclear', 'reactor', 'smr', 'nrc', 'cnsc', 'iaea', 'uranium', 'enrichment', 'isotope',
    'fission', 'fusion', 'candu', 'opg', 'bruce power', 'darlington', 'pickering',
    'cnl', 'doe', 'licensing', 'regulatory', 'safety case', 'decommission',
    'ai', 'artificial intelligence', 'machine learning', 'llm', 'large language model',
    'automation', 'digital twin', 'deep learning', 'neural network',
    'energy', 'power plant', 'grid', 'electricity', 'megawatt', 'gigawatt',
    'data center', 'data centre', 'clean energy', 'decarboni', 'net zero',
  ];
  const keywordRe = new RegExp(RELEVANCE_KEYWORDS.join('|'), 'i');
  const beforeFilter = items.length;
  const filtered = items.filter(item => {
    const text = `${item.title} ${item.summary ?? ''}`;
    return keywordRe.test(text);
  });
  if (filtered.length < beforeFilter) {
    console.log(`Keyword pre-filter: ${beforeFilter} → ${filtered.length} (removed ${beforeFilter - filtered.length} with zero keyword hits)`);
  }

  if (filtered.length === 0) throw new Error('No feed items found after keyword filtering.');

  console.log(`Ranking ${filtered.length} articles...`);
  const { excludedTitles, excludedUrls, rejectedSources } = getSourceHistory();
  const ranked = await rankItems(filtered, {
    recentTitles: getRecentTitles(),
    excludedTitles,
    excludedUrls,
    rejectedSources,
  });

  if (ranked.length === 0) throw new Error('No eligible articles after filtering pending/approved sources.');

  const balanceMultipliers = getTypeBalanceMultipliers();
  const { computeMultiplier: computeTagMultiplier } = getConfidenceWeightedTagScores();

  const now = Date.now();
  const scored: ScoredCandidate[] = ranked
    .filter(r => r.score > 0)
    .map(r => {
      // Select post type using typeFit × weight — the type with the highest
      // weighted score wins, naturally producing a distribution close to targets
      // while respecting article-type fit from the LLM.
      const postType = selectPostType(r.typeFit, balanceMultipliers, lastPostType);
      const balanceMultiplier = balanceMultipliers[postType] ?? 1.0;
      const postContentFeedback = computeTagMultiplier(r.suggestedTags);

      const parsedMs = r.item.pubDate ? new Date(r.item.pubDate).getTime() : NaN;
      const ageDays = isNaN(parsedMs) ? null : Math.floor((now - parsedMs) / (1000 * 60 * 60 * 24));
      const recencyMultiplier =
        ageDays === null ? 1.0
        : ageDays <= 1   ? 1.3
        : ageDays <= 3   ? 1.0
        : ageDays <= 7   ? 0.8
        : ageDays <= 14  ? 0.6
        :                  0.4;

      const combinedScore = r.score * balanceMultiplier * recencyMultiplier * postContentFeedback;
      return { item: r.item, postType, articleScore: r.score, scoreBreakdown: r.breakdown, combinedScore, balanceMultiplier, recencyMultiplier, postContentFeedback, reasoning: r.reasoning };
    });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);

  if (scored.length === 0) throw new Error('No candidates after scoring. All articles may have scored 0.');

  // Save full ranked list
  store = {
    generatedAt: new Date().toISOString(),
    nextIndex: 0,
    candidates: scored,
  };
  writeFileSync(CANDIDATES_FILE, JSON.stringify(store, null, 2));

  // Interactive hook selection for fresh candidates
  const result = await interactiveHookSelection(scored, 0, store);
  if (result) return result;

  // User exited or all candidates exhausted — not an error
  return null;
}

