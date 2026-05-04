// Pipeline V2 — 8-step interactive content generation workflow.
// Each step presents options via Telegram and waits for user selection.
// State is managed in-memory per session.

import { FeedItem } from './rss.js';
import { PostType, POST_TYPE_WEIGHTS } from './persona.js';
import { ScoredCandidate } from './pipeline.js';
import { TypeFitScores } from './rank.js';

// ── Session state ────────────────────────────────────────────────────

export interface PipelineSession {
  id: string;
  step: 'article' | 'postType' | 'hook' | 'post' | 'comments' | 'mentions' | 'image' | 'schedule';
  createdAt: number;

  // Step 1: Article selection
  allCandidates: ScoredCandidate[];
  pageOffset: number;  // current page of 5

  // Step 2: Post-type selection
  selectedArticle?: ScoredCandidate;
  typeFit?: TypeFitScores;
  typeOptions?: Array<{
    postType: PostType;
    fit: number;
    balanceStatus: 'under' | 'on-target' | 'over';
    angle: string;  // LLM-generated perspective description
  }>;
  selectedType?: PostType;
  selectedAngle?: string;

  // Step 3: Hook generation
  hooks?: Array<{ hook: string; score: number; technique: string }>;
  selectedHook?: string;
  hookRegenCount: number;

  // Step 4: Post generation
  generatedContent?: string;
  postDraft?: any; // DraftPost

  // Step 5: Comments
  firstComment?: string;
  loopbackComment?: string;

  // Step 6: Mentions
  // Step 7: Image
  // Step 8: Schedule
  // (to be added in phase 2)
}

const sessions = new Map<string, PipelineSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSIONS_FILE = 'pipeline_sessions.json';

function persistSessions(): void {
  const data: Record<string, PipelineSession> = {};
  for (const [id, s] of sessions) {
    data[id] = s;
  }
  writeFS(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function loadPersistedSessions(): void {
  if (!existsFS(SESSIONS_FILE)) return;
  try {
    const data = JSON.parse(readFS(SESSIONS_FILE, 'utf-8')) as Record<string, PipelineSession>;
    const now = Date.now();
    for (const [id, s] of Object.entries(data)) {
      if (now - s.createdAt < SESSION_TTL_MS) {
        sessions.set(id, s);
      }
    }
    if (sessions.size > 0) {
      console.log(`[pipeline-v2] Restored ${sessions.size} session(s) from disk.`);
    }
  } catch { /* corrupt file — start fresh */ }
}

// Load persisted sessions on module import
loadPersistedSessions();

// Candidate cache — persisted to candidates_v2.json, reused for 1 hour
import { readFileSync as readFS, writeFileSync as writeFS, existsSync as existsFS } from 'fs';

const CANDIDATE_CACHE_FILE = 'candidates_v2.json';
const CANDIDATE_CACHE_TTL_MS = 60 * 60 * 1000;

export function getCachedCandidates(): ScoredCandidate[] | null {
  if (!existsFS(CANDIDATE_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(readFS(CANDIDATE_CACHE_FILE, 'utf-8'));
    if (data.cachedAt && Date.now() - data.cachedAt < CANDIDATE_CACHE_TTL_MS) {
      return data.candidates;
    }
  } catch { /* expired or corrupt */ }
  return null;
}

export function setCachedCandidates(candidates: ScoredCandidate[]): void {
  writeFS(CANDIDATE_CACHE_FILE, JSON.stringify({ cachedAt: Date.now(), candidates }, null, 2));
}

export function createSession(candidates: ScoredCandidate[]): PipelineSession {
  // Clean up expired sessions
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }

  const session: PipelineSession = {
    id: `ps_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    step: 'article',
    createdAt: now,
    allCandidates: candidates,
    pageOffset: 0,
    hookRegenCount: 0,
  };
  sessions.set(session.id, session);
  persistSessions();
  return session;
}

export function getSession(id: string): PipelineSession | null {
  return sessions.get(id) ?? null;
}

/** Call after modifying any session properties to persist to disk. */
export function saveSession(session: PipelineSession): void {
  sessions.set(session.id, session);
  persistSessions();
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  persistSessions();
}

export function getAllSessions(): PipelineSession[] {
  return [...sessions.values()];
}

// ── Step 1: Article Selection ────────────────────────────────────────

export interface ArticleOption {
  rank: number;
  title: string;
  source: string;
  link: string;
  articleScore: number;
  scoreBreakdown: { intersection: number; novelty: number; geography: number; npx: number };
  balanceMultiplier: number;
  recencyMultiplier: number;
  postContentFeedback: number;
  combinedScore: number;
  synopsis: string;
  suggestedPostType: PostType;
  reasoning: string;
}

export function getArticlePage(session: PipelineSession): ArticleOption[] {
  const start = session.pageOffset;
  const page = session.allCandidates.slice(start, start + 5);

  return page.map((c, i) => ({
    rank: start + i + 1,
    title: c.item.title,
    source: c.item.source,
    link: c.item.link,
    articleScore: c.articleScore,
    scoreBreakdown: c.scoreBreakdown,
    balanceMultiplier: c.balanceMultiplier,
    recencyMultiplier: c.recencyMultiplier,
    postContentFeedback: c.postContentFeedback,
    combinedScore: c.combinedScore,
    synopsis: c.synopsis ?? c.item.summary?.slice(0, 200) ?? '',
    suggestedPostType: c.postType,
    reasoning: c.reasoning,
  }));
}

export function selectArticle(session: PipelineSession, index: number): ScoredCandidate {
  const globalIndex = session.pageOffset + index;
  const candidate = session.allCandidates[globalIndex];
  session.selectedArticle = candidate;
  session.step = 'postType';
  return candidate;
}

export function nextArticlePage(session: PipelineSession): boolean {
  const newOffset = session.pageOffset + 5;
  if (newOffset >= session.allCandidates.length) return false;
  session.pageOffset = newOffset;
  return true;
}

// ── Step 2: Post-Type Selection ──────────────────────────────────────

export function getTypeBalanceStatus(postType: PostType, balanceMultipliers: Partial<Record<PostType, number>>): 'under' | 'on-target' | 'over' {
  const m = balanceMultipliers[postType] ?? 1.0;
  if (m > 1.1) return 'under';
  if (m < 0.9) return 'over';
  return 'on-target';
}

export interface TypeSelectionResult {
  options: Array<{
    postType: PostType;
    fit: number;
    combinedScore: number;
    balanceStatus: 'under' | 'on-target' | 'over';
    angle: string;
  }>;
}

export async function generateTypeOptions(
  session: PipelineSession,
  balanceMultipliers: Partial<Record<PostType, number>>,
): Promise<TypeSelectionResult> {
  const candidate = session.selectedArticle!;
  const typeFit = candidate.typeFit ?? {};

  // Score all types and pick top 3
  const typeScores: Array<{ postType: PostType; fit: number; combinedScore: number }> = [];
  for (const [type, weight] of Object.entries(POST_TYPE_WEIGHTS) as [PostType, number][]) {
    if (weight == null) continue;
    const fit = typeFit[type] ?? 0;
    const balance = balanceMultipliers[type] ?? 1.0;
    const score = fit * Math.sqrt(weight) * balance;
    typeScores.push({ postType: type, fit, combinedScore: score });
  }
  typeScores.sort((a, b) => b.combinedScore - a.combinedScore);
  const top3 = typeScores.slice(0, 3);

  // Generate angle descriptions for the top 3 using LLM
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic();

  const articleContext = candidate.item.fullText
    ? `Article: "${candidate.item.title}"\n${candidate.item.fullText.split(/\s+/).slice(0, 500).join(' ')}`
    : `Article: "${candidate.item.title}"\nSummary: ${candidate.item.summary}`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `${articleContext}

For each of these 3 LinkedIn post types, describe in 1-2 sentences what angle and perspective the post would take. Be specific about the argument, the data point to lead with, and who the target audience is.

${top3.map((t, i) => `${i + 1}. ${t.postType} (fit: ${t.fit}/10)`).join('\n')}

Return ONLY valid JSON array:
[
  { "postType": "<type>", "angle": "<1-2 sentence description>" },
  { "postType": "<type>", "angle": "<1-2 sentence description>" },
  { "postType": "<type>", "angle": "<1-2 sentence description>" }
]`,
    }],
  });

  const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '[]';
  let angles: Array<{ postType: string; angle: string }> = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) angles = JSON.parse(match[0]);
  } catch { /* fallback to empty angles */ }

  const options = top3.map((t, i) => ({
    postType: t.postType,
    fit: t.fit,
    combinedScore: t.combinedScore,
    balanceStatus: getTypeBalanceStatus(t.postType, balanceMultipliers),
    angle: angles[i]?.angle ?? `${t.postType} post based on this article.`,
  }));

  session.typeOptions = options;
  session.typeFit = typeFit;

  return { options };
}

export function selectType(session: PipelineSession, index: number): void {
  const option = session.typeOptions![index];
  session.selectedType = option.postType;
  session.selectedAngle = option.angle;
  session.step = 'hook';
}

export function backToArticleSelection(session: PipelineSession): void {
  session.selectedArticle = undefined;
  session.typeOptions = undefined;
  session.selectedType = undefined;
  session.selectedAngle = undefined;
  session.step = 'article';
}

// ── Step 3: Hook Generation ──────────────────────────────────────────

export { generateHookCandidates, screenHookCandidates } from './synthesize.js';

// ── Fetch + Rank + Score (reuses existing pipeline infrastructure) ───

export async function fetchAndRankArticles(): Promise<ScoredCandidate[]> {
  const { fetchLatestItems } = await import('./rss.js');
  const { fetchNewsDataItems } = await import('./newsdata.js');
  const { rankItems } = await import('./rank.js');
  const { getRecentTitles, getLastPostType, getTypeBalanceMultipliers } = await import('./pipeline.js');
  const { getSourceHistory } = await import('../hitl/queue.js');
  const { getConfidenceWeightedTagScores } = await import('../analytics/feedback.js');
  const { pickPostType } = await import('./persona.js');

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
  console.log(`Total articles: ${items.length} (${rssItems.length} RSS + ${newsDataItems.length} NewsData)`);

  // Keyword pre-filter
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
  const filtered = items.filter(item => keywordRe.test(`${item.title} ${item.summary ?? ''}`));
  console.log(`After keyword filter: ${filtered.length} articles`);

  if (filtered.length === 0) throw new Error('No feed items found after keyword filtering.');

  console.log(`Ranking ${filtered.length} articles...`);
  const { excludedTitles, excludedUrls, rejectedSources } = getSourceHistory();
  const ranked = await rankItems(filtered, {
    recentTitles: getRecentTitles(),
    excludedTitles,
    excludedUrls,
    rejectedSources,
  });

  if (ranked.length === 0) throw new Error('No eligible articles after filtering.');

  const lastPostType = getLastPostType();
  const balanceMultipliers = getTypeBalanceMultipliers();
  const { computeMultiplier: computeTagMultiplier } = getConfidenceWeightedTagScores();
  const now = Date.now();

  // Import selectPostType from pipeline
  const selectPostType = (typeFit: Record<string, number>, balanceMults: Partial<Record<PostType, number>>, last?: PostType): PostType => {
    const maxFit = Math.max(...Object.values(typeFit).map(v => v ?? 0));
    if (maxFit < 4) return pickPostType(last);

    let bestType: PostType = 'bridge';
    let bestScore = -1;
    for (const [type, weight] of Object.entries(POST_TYPE_WEIGHTS) as [PostType, number][]) {
      if (weight == null) continue;
      const fit = typeFit[type] ?? 0;
      const balance = balanceMults[type] ?? 1.0;
      const score = fit * Math.sqrt(weight) * balance;
      const adjusted = (type === last) ? score * 0.7 : score;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestType = type;
      }
    }
    return bestType;
  };

  const scored: ScoredCandidate[] = ranked
    .filter(r => r.score > 0)
    .map(r => {
      const postType = selectPostType(r.typeFit, balanceMultipliers, lastPostType);
      const balanceMultiplier = balanceMultipliers[postType] ?? 1.0;
      const postContentFeedback = computeTagMultiplier(r.suggestedTags);

      const parsedMs = r.item.pubDate ? new Date(r.item.pubDate).getTime() : NaN;
      const ageHours = isNaN(parsedMs) ? null : (now - parsedMs) / (1000 * 60 * 60);
      const recencyMultiplier =
        ageHours === null  ? 1.0
        : ageHours <= 24   ? 1.3
        : ageHours <= 72   ? 1.0
        : ageHours <= 168  ? 0.8
        : ageHours <= 336  ? 0.6
        :                    0.4;

      const combinedScore = r.score * balanceMultiplier * recencyMultiplier * postContentFeedback;
      return {
        item: r.item, postType, articleScore: r.score, scoreBreakdown: r.breakdown,
        combinedScore, balanceMultiplier, recencyMultiplier, postContentFeedback,
        reasoning: r.reasoning, synopsis: r.synopsis, typeFit: r.typeFit,
      };
    });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);

  if (scored.length === 0) throw new Error('No candidates after scoring.');

  console.log(`Ranked ${scored.length} candidates. Top: "${scored[0].item.title.slice(0, 50)}..." (${scored[0].combinedScore.toFixed(1)})`);
  return scored;
}

export function selectHook(session: PipelineSession, hook: string): void {
  session.selectedHook = hook;
  session.step = 'post';
}

export function backToArticleFromHook(session: PipelineSession): void {
  session.selectedArticle = undefined;
  session.typeOptions = undefined;
  session.selectedType = undefined;
  session.selectedAngle = undefined;
  session.hooks = undefined;
  session.selectedHook = undefined;
  session.hookRegenCount = 0;
  session.step = 'article';
}

// ── Step 4: Post Generation ──────────────────────────────────────────

export async function generatePost(session: PipelineSession): Promise<string> {
  const { synthesizePost } = await import('./synthesize.js');
  const { verifyPost } = await import('./verify.js');
  const { screenPost } = await import('./screen.js');
  const { stripMentionMarkers, reInjectMentionMarkers } = await import('./pipeline.js');
  const { injectMentionMarkers } = await import('./synthesize.js');

  const item = session.selectedArticle!.item;
  const postType = session.selectedType!;

  console.log(`[pipeline-v2] Generating ${postType} post...`);
  let draft = await synthesizePost(item, postType, session.selectedHook, { skipComments: true });

  // Store full draft on session
  session.postDraft = draft;

  let content = draft.content;

  // Fact verification
  const { clean: cleanContent, markers } = stripMentionMarkers(content);
  const verificationSource = item.fullText ?? item.summary;
  if (verificationSource) {
    console.log('[pipeline-v2] Verifying factual claims...');
    const verification = await verifyPost(cleanContent, verificationSource);
    if (verification.changed) {
      console.log(`[pipeline-v2] Verifier corrected ${verification.flaggedClaims.length} claim(s)`);
      content = reInjectMentionMarkers(verification.correctedContent, markers);
    } else {
      content = reInjectMentionMarkers(cleanContent, markers);
    }
  }

  // Screening
  console.log('[pipeline-v2] Running screener...');
  const screeningDraft = { ...draft, content: stripMentionMarkers(content).clean };
  const screening = await screenPost(screeningDraft);
  console.log(`[pipeline-v2] Cringe: ${screening.cringeScore}/10`);

  if (screening.cringeScore > 3 && screening.revisedContent) {
    content = reInjectMentionMarkers(screening.revisedContent, markers);
  }

  // Lock hook
  if (session.selectedHook) {
    const firstBreak = content.indexOf('\n\n');
    if (firstBreak > 0) {
      const currentHook = content.slice(0, firstBreak);
      if (currentHook !== session.selectedHook) {
        content = session.selectedHook + content.slice(firstBreak);
      }
    }
  }

  content = injectMentionMarkers(content);
  session.generatedContent = content;
  session.postDraft = { ...draft, content, screening };
  session.step = 'post';
  return content;
}

export function approvePostText(session: PipelineSession): void {
  session.step = 'comments';
}

export function backToArticleFromPost(session: PipelineSession): void {
  session.generatedContent = undefined;
  session.postDraft = undefined;
  session.hooks = undefined;
  session.selectedHook = undefined;
  session.hookRegenCount = 0;
  session.typeOptions = undefined;
  session.selectedType = undefined;
  session.selectedAngle = undefined;
  session.selectedArticle = undefined;
  session.step = 'article';
}

// ── Step 5: Comments Generation ──────────────────────────────────────

export async function generateComments(session: PipelineSession): Promise<{ firstComment: string; loopbackComment: string }> {
  const { synthesizeFirstComment, synthesizeLoopbackComment } = await import('./synthesize-comments.js');
  const item = session.selectedArticle!.item;
  const content = session.generatedContent!;

  console.log('[pipeline-v2] Generating first comment...');
  const firstComment = await synthesizeFirstComment(content);

  console.log('[pipeline-v2] Generating loopback comment...');
  const loopbackComment = await synthesizeLoopbackComment(content, firstComment, item);

  session.firstComment = firstComment;
  session.loopbackComment = loopbackComment;
  return { firstComment, loopbackComment };
}

export function approveComments(session: PipelineSession): void {
  session.step = 'mentions';
}

export function updateComments(session: PipelineSession, firstComment: string, loopbackComment: string): void {
  session.firstComment = firstComment;
  session.loopbackComment = loopbackComment;
}

// ── Step 6: Mentions ─────────────────────────────────────────────────

export async function processMentions(session: PipelineSession): Promise<string[]> {
  const { addUnverifiedMentions, verifiedMentions } = await import('../poster/mentions.js');
  const content = session.generatedContent!;

  // Extract company names and register unverified mentions
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic();

  let newMentions: string[] = [];
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Extract all company and organization names from this LinkedIn post that could be @mentioned. Return ONLY a JSON array of strings.\n\n${content}`,
      }],
    });
    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const names = JSON.parse(match[0]) as string[];
      const verified = verifiedMentions();
      newMentions = names.filter(n => !(n in verified));
      if (newMentions.length > 0) {
        addUnverifiedMentions(newMentions);
      }
    }
  } catch { /* non-fatal */ }

  return newMentions;
}

export function confirmMentions(session: PipelineSession): void {
  session.step = 'image';
}

// ── Step 7: Image — handled by existing image flow ───────────────────
// ── Step 8: Schedule ─────────────────────────────────────────────────

export function getScheduleOptions(): Array<{ label: string; time: string }> {
  const { TIME_WINDOWS, pickScheduledTime } = require('../scheduler/windows.js');
  const suggested = pickScheduledTime();
  const suggestedDate = new Date(suggested);
  const fmt = (d: Date) => d.toLocaleString('en-US', {
    timeZone: 'America/Toronto',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  const options: Array<{ label: string; time: string }> = [
    { label: `${fmt(suggestedDate)} (suggested)`, time: suggested },
  ];

  // Add alternatives — other windows on the same day
  for (const w of TIME_WINDOWS) {
    const alt = pickScheduledTime(); // each call picks a random time
    if (alt !== suggested) {
      options.push({ label: fmt(new Date(alt)), time: alt });
    }
    if (options.length >= 4) break;
  }

  return options;
}
