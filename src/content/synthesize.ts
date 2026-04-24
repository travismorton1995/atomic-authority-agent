import Anthropic from '@anthropic-ai/sdk';
import { FeedItem } from './rss.js';
import { PostType, SYSTEM_PROMPT, POST_TYPE_INSTRUCTIONS, WORD_COUNT_TARGETS } from './persona.js';
import { verifiedMentions } from '../poster/mentions.js';

const client = new Anthropic();

export const CONTENT_TAGS = [
  // Regulatory / safety
  'regulatory', 'safety-case', 'licensing', 'cnsc', 'nrc', 'iaea',
  // Reactor / technology
  'smr', 'candu', 'reactor-design', 'decommissioning', 'new-build', 'fusion',
  // AI angle
  'llm', 'machine-learning', 'digital-twin', 'anomaly-detection', 'document-automation', 'explainability',
  // Organizational
  'change-management', 'workforce', 'trust', 'adoption',
  // Geography — Canada regional
  'ontario', 'quebec', 'western-canada', 'eastern-canada', 'territories',
  // Geography — other
  'uk',
  // Geography — US regional
  'doe', 'ferc', 'southeast-us', 'midwest-us', 'northeast-us', 'southwest-us', 'northwest-us',
  // Other
  'cybersecurity', 'public-opinion',
] as const;

export type ContentTag = typeof CONTENT_TAGS[number];

export interface HookCandidate {
  hook: string;
  score: number;
  technique: string;
}

export interface DraftPost {
  content: string;
  firstComment: string;
  title: string;            // short 3-5 word internal title for tracking/reporting
  postType: PostType;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  sourceFeed: string;       // RSS feed name (e.g. "ANS Newswire", "Bruce Power")
  combinedScore?: number;   // article score after all multipliers
  scoreBreakdown?: { intersection: number; novelty: number; geography: number; npx: number };
  balanceMultiplier?: number;
  recencyMultiplier?: number;
  postContentFeedback?: number;
  contentTags?: ContentTag[]; // topic tags for engagement learning
  generatedAt: string;
  imageUrl?: string;
  generatedImagePath?: string; // local path to AI-generated image file
  stockImageUrl?: string;      // Unsplash stock photo URL (selected option)
  stockImagePhotographer?: string; // Unsplash photographer credit
  stockImageDownloadUrl?: string;  // Unsplash download tracking URL
  stockImageOptions?: Array<{ url: string; photographer: string; downloadUrl: string; description: string }>; // all stock candidates
  wordCount?: number;          // word count of final post content
  articleFullText?: string;     // cached full article text for rewrites/verification
}

const HOOK_THRESHOLD = 7;
const HOOKS_PER_ROUND = 3;
const MAX_HOOK_ROUNDS = 2;

function articleAgeDays(pubDate: string): number | null {
  if (!pubDate) return null;
  const ms = Date.now() - new Date(pubDate).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return isNaN(days) ? null : days;
}

function ageLanguageRule(ageDays: number | null): string {
  if (ageDays === null) return '';
  if (ageDays <= 2) return 'The article is very recent — time-sensitive language ("just announced", "this week") is appropriate.';
  if (ageDays <= 7) return `The article is ${ageDays} days old. Avoid "just" or "today" — use "recently" or past tense at most.`;
  return `The article is ${ageDays} days old. Do NOT use any recency language ("just", "recently", "this week", "new", "breaking"). Write in past tense and frame it as established context, not breaking news.`;
}

async function generateBestHook(item: FeedItem, postType: PostType): Promise<string> {
  let bestHook = '';
  let bestScore = 0;

  const articleSnippet = item.fullText
    ? item.fullText.split(/\s+/).slice(0, 200).join(' ')
    : item.summary?.slice(0, 400) ?? '';

  const ageDays = articleAgeDays(item.pubDate);
  const ageRule = ageLanguageRule(ageDays);

  for (let round = 0; round < MAX_HOOK_ROUNDS; round++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Generate ${HOOKS_PER_ROUND} candidate opening lines for a LinkedIn post, then score each one.

Article: ${item.title}
Source: ${item.source}
Content snippet: ${articleSnippet}
Post type: ${postType}
${ageRule ? `\nTEMPORAL RULE: ${ageRule}` : ''}

HARD CONSTRAINT: Each hook must be under 140 characters. Score 0 if over 140 chars.

HOOK TECHNIQUES (use one per candidate — try different techniques across the 3 candidates):

1. TENSION GAP — state a fact that creates an obvious "wait, why?" reaction
   "Only two projects in all of Texas qualify for the state's $350M nuclear fund."
   "The DOE's AI tool wrote 208 pages in 24 hours. A reviewer called it production-ready."

2. UNEXPECTED NUMBER — lead with a specific stat that feels wrong or surprising
   "Nuclear energy just hit a 20-year confidence peak."
   "50 GW of fusion by 2035. That's France's entire nuclear fleet."

3. CONTRAST/IRONY — juxtapose two things that shouldn't go together
   "Alaska is building microreactors while New York is banning them."
   "The constraint isn't physics. It's paperwork."

4. CONSEQUENCE LEAD — skip the news, go straight to what it means
   "Every advanced reactor developer just got a new licensing shortcut."
   "Nuclear cyber defense just went international."

5. PROVOCATIVE CLAIM — say something mildly bold that earns the scroll
   "Most nuclear AI announcements won't survive first contact with operations."
   "The companies moving fastest in nuclear are the ones that moved slowest first."

RULES:
- Under 140 characters (mandatory — score 0 if over)
- Each candidate must use a DIFFERENT technique from the list above
- Do NOT restate the article headline — find the buried insight, the implication, or the tension
- Do NOT start with "I", "In [year]", a rhetorical question, or a definition
- Do NOT use "just" as the second word (e.g. "[Company] just...") — find a more engaging entry point
- The hook should make someone stop scrolling and want to know more

SCORING:
- 9-10: Makes you stop scrolling. Creates genuine curiosity or tension. Under 140 chars.
- 7-8: Strong hook with clear tension or surprise. Under 140 chars.
- 4-6: Informative but doesn't create urgency to read more.
- 1-3: Headline restatement, generic, or over 140 chars.

Return ONLY a valid JSON array (no markdown, no extra text):
[{"hook": "<opening line>", "score": <1-10>}, ...]`,
      }],
    });

    const rawText = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.warn(`Hook round ${round + 1}: no JSON array in response — skipping.`);
      continue;
    }

    try {
      const hooks = JSON.parse(arrayMatch[0]) as Array<{ hook: string; score: number }>;
      let rejected = 0;
      for (const h of hooks) {
        // Hard reject hooks over 140 chars — mobile truncation limit
        if (h.hook.length > 140) { rejected++; continue; }
        if (h.score > bestScore) {
          bestScore = h.score;
          bestHook = h.hook;
        }
      }
      if (rejected > 0) console.log(`Hook round ${round + 1}: rejected ${rejected} hook(s) over 140 chars.`);
    } catch {
      console.warn(`Hook round ${round + 1}: JSON parse failed — skipping.`);
      continue;
    }

    if (bestScore >= HOOK_THRESHOLD) break;
  }

  console.log(`Best hook score: ${bestScore}/10`);
  return bestHook;
}

// Generate multiple hook candidates for interactive selection via Telegram.
// Returns up to 5 hooks sorted by score, each with the technique used.
export async function generateHookCandidates(item: FeedItem, postType: PostType): Promise<HookCandidate[]> {
  const articleSnippet = item.fullText
    ? item.fullText.split(/\s+/).slice(0, 200).join(' ')
    : item.summary?.slice(0, 400) ?? '';

  const ageDays = articleAgeDays(item.pubDate);
  const ageRule = ageLanguageRule(ageDays);

  const allHooks: HookCandidate[] = [];

  for (let round = 0; round < 2; round++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Generate 5 candidate opening lines for a LinkedIn post, then score each one.

Article: ${item.title}
Source: ${item.source}
Content snippet: ${articleSnippet}
Post type: ${postType}
${ageRule ? `\nTEMPORAL RULE: ${ageRule}` : ''}

HARD CONSTRAINT: Each hook must be under 140 characters. Score 0 if over 140 chars.

MANDATORY: Every hook MUST include at least one specific entity from the article — a company name, location, dollar figure, or number. Generic hooks with no concrete nouns score 0.

TOP-PERFORMING HOOK EXAMPLES (study these — they all contain specific entities and create stakes):
- "Bruce Power's cobalt-60 harvest builds on 60 years of isotope innovation at Chalk River."
- "Only two projects in all of Texas qualify for the state's $350M nuclear fund."
- "Port Hope is still cleaning up Manhattan Project uranium. Now Ontario wants to build a 10 GW plant next door."

HOOK TECHNIQUES (use one per candidate — each candidate must use a DIFFERENT technique):

1. TENSION GAP — state a fact that creates an obvious "wait, why?" reaction
2. UNEXPECTED NUMBER — lead with a specific stat that feels wrong or surprising
3. CONTRAST/IRONY — juxtapose two things that shouldn't go together
4. CONSEQUENCE LEAD — skip the news, go straight to what it means
5. PROVOCATIVE CLAIM — say something mildly bold that earns the scroll

RULES:
- Under 140 characters (mandatory — score 0 if over)
- Each candidate must use a DIFFERENT technique from the list above
- Must include at least one specific entity (company, place, dollar figure, number)
- Do NOT restate the article headline — find the buried insight, the implication, or the tension
- Do NOT start with "I", "In [year]", a rhetorical question, or a definition
- Do NOT use "just" as the second word (e.g. "[Company] just...") — find a more engaging entry point
${round > 0 ? `\nPrevious hooks (do NOT repeat these — generate completely different angles):\n${allHooks.map(h => `- "${h.hook}"`).join('\n')}` : ''}

SCORING:
- 9-10: Makes you stop scrolling. Creates genuine curiosity or tension. Contains a specific entity. Under 140 chars.
- 7-8: Strong hook with clear tension or surprise. Contains a specific entity. Under 140 chars.
- 4-6: Informative but doesn't create urgency to read more, or missing specific entity.
- 1-3: Headline restatement, generic, no concrete nouns, or over 140 chars.

Return ONLY a valid JSON array (no markdown, no extra text):
[{"hook": "<opening line>", "score": <1-10>, "technique": "<technique name>"}, ...]`,
      }],
    });

    const rawText = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (!arrayMatch) continue;

    try {
      const hooks = JSON.parse(arrayMatch[0]) as Array<{ hook: string; score: number; technique?: string }>;
      for (const h of hooks) {
        if (h.hook.length > 140) continue;
        allHooks.push({ hook: sanitizeHook(h.hook), score: h.score, technique: h.technique ?? 'unknown' });
      }
    } catch {
      continue;
    }

    // Stop after round 1 if we already have 5+ valid hooks
    if (allHooks.length >= 5) break;
  }

  // Deduplicate by hook text and sort by score descending
  const seen = new Set<string>();
  const unique = allHooks.filter(h => {
    const key = h.hook.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.score - a.score);
  return unique.slice(0, 5);
}

// Hard code-level sanitizer for hooks — catches AI-isms the LLM screening misses.
function sanitizeHook(hook: string): string {
  let h = hook;
  // Replace em-dashes with comma or period
  h = h.replace(/\s*—\s*/g, ', ');
  // Replace en-dashes used as em-dashes
  h = h.replace(/\s*–\s*/g, ', ');
  // Clean up double commas from replacements
  h = h.replace(/,\s*,/g, ',');
  // Clean up ", ." patterns
  h = h.replace(/,\s*\./g, '.');
  // Trim trailing/leading whitespace
  return h.trim();
}

// Screen and fact-check hook candidates before presenting to user.
// A single LLM call checks all hooks against the article for factual accuracy
// and AI-isms. Returns only hooks that pass, with any minor fixes applied.
export async function screenHookCandidates(
  hooks: HookCandidate[],
  articleTitle: string,
  articleText: string,
): Promise<HookCandidate[]> {
  if (hooks.length === 0) return [];

  const snippet = articleText.split(/\s+/).slice(0, 300).join(' ');
  const hookList = hooks.map((h, i) => `${i + 1}. "${h.hook}" [${h.technique}, ${h.score}/10]`).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a fact-checker and copy editor for LinkedIn hooks. Review each hook against the article and fix issues.

ARTICLE TITLE: ${articleTitle}
ARTICLE TEXT: ${snippet}

HOOKS TO REVIEW:
${hookList}

For each hook, check:
1. FACTUAL ACCURACY (critical): Every claim, number, name, and acronym expansion must be supported by the article. If factually wrong, fix it. Only mark as "drop" if the fact cannot be fixed.
2. AI-ISMS (fix only): Fix em-dashes (—) to commas or periods. Fix "is real", "game-changer", "transformative", "delve", "dive in". Do NOT drop hooks for being vague, clickbaity, rhetorical, or provocative — these are intentional engagement techniques.
3. LENGTH: Must be under 140 characters after any edits.

IMPORTANT: Hooks are ALLOWED to be vague, surprising, clickbaity, or use rhetorical devices. Only drop a hook if it contains a factual error that cannot be fixed. When in doubt, fix rather than drop.

Return ONLY a valid JSON array (no markdown, no extra text):
[{"index": <1-based>, "status": "pass" | "fixed" | "drop", "hook": "<original or fixed text>", "reason": "<brief reason if fixed or dropped>"}]`,
      }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.warn('[hook-screen] No JSON array in response — returning hooks unscreened.');
      return hooks;
    }

    const results = JSON.parse(arrayMatch[0]) as Array<{
      index: number;
      status: 'pass' | 'fixed' | 'drop';
      hook: string;
      reason?: string;
    }>;

    const screened: HookCandidate[] = [];
    for (const r of results) {
      if (r.status === 'drop') {
        console.log(`  [hook-screen] Dropped hook ${r.index}: ${r.reason ?? 'no reason'}`);
        continue;
      }
      const original = hooks[r.index - 1];
      if (!original) continue;

      let finalHook = r.hook.length <= 140 ? r.hook : original.hook;
      // Hard code-level sanitizer — catch AI-isms the LLM screening missed
      finalHook = sanitizeHook(finalHook);
      if (finalHook.length > 140) finalHook = finalHook.slice(0, 140);
      if (r.status === 'fixed' && r.hook !== original.hook) {
        console.log(`  [hook-screen] Fixed hook ${r.index}: "${original.hook.slice(0, 50)}..." → "${finalHook.slice(0, 50)}..."`);
      }
      screened.push({ hook: finalHook, score: original.score, technique: original.technique });
    }

    // If screening dropped everything, return originals as fallback
    if (screened.length === 0) {
      console.warn('[hook-screen] All hooks dropped — returning originals as fallback.');
      return hooks;
    }

    return screened;
  } catch (err: any) {
    console.warn(`[hook-screen] Screening failed: ${err?.message ?? err} — returning hooks unscreened.`);
    return hooks;
  }
}

// Wraps verified company names in post text with [[MENTION:Name]] markers.
// Matches only whole-word occurrences; skips if already wrapped.
// Longer names are matched first to avoid partial replacements (e.g. "CNL" inside "Canadian Nuclear Laboratories").
// Mentions can appear anywhere in the post including the hook — long-name orgs that
// expand poorly (CNSC, NRC, IAEA, DOE) are blocklisted so only clean short names get tagged.
// The LLM screener is responsible for removing mentions that aren't primary subjects of the post.
export function injectMentionMarkers(text: string): string {
  const verified = verifiedMentions();
  if (Object.keys(verified).length === 0) return text;

  // Sort by length descending so longer names match before shorter abbreviations
  const names = Object.keys(verified).sort((a, b) => b.length - a.length);
  let result = text;

  for (const name of names) {
    const marker = `[[MENTION:${name}]]`;
    if (result.includes(marker)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Use lookahead/lookbehind for word chars instead of \b — handles hyphenated names (e.g. X-energy)
    result = result.replace(new RegExp(`(?<!#)(?<!\\w)${escaped}(?!\\w)`), marker);
  }

  return result;
}

// Computes hashtag performance from posted_history.json.
// Returns a ranked list of hashtags with avg engagement, sorted best-first.
// Hashtag performance and correlation insights now use the analytics module.
import { getConfidenceWeightedHashtagPerformance, getCorrelationInsights } from '../analytics/feedback.js';
import { robustAverage } from '../analytics/stats.js';

export async function synthesizePost(item: FeedItem, postType: PostType, selectedHook?: string): Promise<DraftPost> {
  const articleContent = item.fullText
    ? `Summary: ${item.summary}\n\nFull article text:\n${item.fullText}`
    : `Summary: ${item.summary}`;

  const ageDays = articleAgeDays(item.pubDate);
  const ageRule = ageLanguageRule(ageDays);

  // Use pre-selected hook if provided (from interactive hook selection), otherwise auto-generate
  let bestHook: string;
  if (selectedHook) {
    bestHook = selectedHook;
    console.log(`Using selected hook: "${bestHook}"`);
  } else {
    console.log('Generating hooks...');
    bestHook = await generateBestHook(item, postType);
  }
  const hookConstraint = bestHook
    ? `\nOPENING LINE (use this exact sentence as your first line — do not alter it):\n${bestHook}\n`
    : '';

  // Build hashtag guidance from historical performance (confidence-weighted)
  // Build unified hashtag selection instructions — analytics first, curated fallback second.
  // One clear instruction block, no ambiguity.
  const hashtagPerf = getConfidenceWeightedHashtagPerformance();
  let hashtagGuidance = '\nHASHTAG SELECTION (follow these rules exactly — this is your only source for hashtag decisions):\n';
  hashtagGuidance += 'Use the PYRAMID structure: 1 broad tag + 2-3 niche tags + 1 optional branded tag. Never exceed 5 total.\n';

  if (hashtagPerf.length > 0) {
    const globalAvg = robustAverage(hashtagPerf.map(h => h.score));
    const above = hashtagPerf.filter(h => h.score >= globalAvg);
    const below = hashtagPerf.filter(h => h.score < globalAvg);

    const formatLine = (h: typeof hashtagPerf[0]) => {
      const conf = h.confidence === 'low' ? ' (low confidence)' : '';
      return `${h.hashtag} (${h.n} posts, avg ${h.score.toFixed(1)} score${conf})`;
    };

    console.log(`Hashtag performance (avg ${globalAvg.toFixed(1)}): ${hashtagPerf.map(h => `${h.hashtag} ${h.score.toFixed(1)}`).join(', ')}`);

    hashtagGuidance += `\nPERFORMANCE DATA (use this to decide — above-average hashtags first, avoid below-average when a better alternative exists):
${above.length > 0 ? `Above average:\n${above.map(formatLine).join('\n')}` : ''}
${below.length > 0 ? `Below average:\n${below.map(formatLine).join('\n')}` : ''}
`;
  } else {
    console.log('Hashtag performance: no eligible hashtags yet (need 2+ posts each).');
  }

  hashtagGuidance += `\nCURATED FALLBACK LIST (use these ONLY when no performance data exists for a relevant topic):
Broad: #NuclearEnergy, #CleanEnergy, #AI, #ArtificialIntelligence
Nuclear niche: #SMR, #NuclearInnovation, #NuclearTechnology, #NetZero, #AdvancedReactors, #NuclearSafety, #EnergyTransition, #Decarbonization
AI niche: #GenerativeAI, #AIAutomation, #MachineLearning, #FutureOfWork, #LLM, #AIGovernance
Regulatory: #NRC, #LicensingReform, #EnergyPolicy, #CriticalInfrastructure
Branded: #NPX (only when directly relevant to NPX work)

PRIORITY ORDER: Performance data > Curated list > Relevance judgment. Never force an irrelevant hashtag just because it performed well.\n`;

  // Build correlation insights for synthesis guidance
  const corrInsights = getCorrelationInsights();
  let corrGuidance = '';
  const significantCorrs = corrInsights.filter(c => c.significant);
  if (significantCorrs.length > 0) {
    const lines = significantCorrs.map(c => {
      if (c.attribute === 'Word count' && c.r < 0) return 'DATA INSIGHT: Your shorter posts have historically performed better. Aim for the lower end of the word count range.';
      if (c.attribute === 'Word count' && c.r > 0) return 'DATA INSIGHT: Your longer posts have historically performed better. Aim for the upper end of the word count range.';
      if (c.attribute === 'Cringe score' && c.r < 0) return 'DATA INSIGHT: Posts with lower cringe scores (cleaner, less AI-sounding) perform significantly better.';
      return null;
    }).filter(Boolean);
    if (lines.length > 0) corrGuidance = '\n' + lines.join('\n') + '\n';
  }

  const userPrompt = `NEWS ITEM:
Title: ${item.title}
Source: ${item.source}
Date: ${item.pubDate}
URL: ${item.link}
${articleContent}

POST TYPE: ${postType}
INSTRUCTION: ${POST_TYPE_INSTRUCTIONS[postType]}
WORD COUNT: Target ${WORD_COUNT_TARGETS[postType].reviseMin}–${WORD_COUNT_TARGETS[postType].reviseMax} words. Hard limits: min ${WORD_COUNT_TARGETS[postType].min}, max ${WORD_COUNT_TARGETS[postType].max}.
${ageRule ? `TEMPORAL RULE: ${ageRule}\n` : ''}${hookConstraint}${hashtagGuidance}${corrGuidance}
Write the LinkedIn post now. You have the full article text above — use specific facts, figures, quotes, or details from it where they strengthen the post. Output only the post text — no preamble, no "here is your post," no quotation marks wrapping the whole thing.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let rawContent = message.content[0].type === 'text' ? message.content[0].text.trim() : '';

  // Fix a/an agreement (e.g. "A April" → "An April", "an project" → "a project")
  rawContent = rawContent
    .replace(/\bA ([AEIOUaeiou])/g, 'An $1')
    .replace(/\ban ([^AEIOUaeiouAEIOUaeiou\s])/g, 'a $1');

  // Word count enforcement: revise if outside per-type range
  const targets = WORD_COUNT_TARGETS[postType];
  const wordCount = rawContent.split(/\s+/).filter(Boolean).length;
  if (wordCount < targets.min || wordCount > targets.max) {
    console.log(`Word count ${wordCount} outside ${targets.min}-${targets.max} for ${postType} — revising...`);
    const reviseMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `This LinkedIn post is ${wordCount} words, which is ${wordCount < targets.min ? `too short (minimum ${targets.min})` : `too long (maximum ${targets.max})`}. Revise it to be between ${targets.reviseMin}–${targets.reviseMax} words. Preserve the opening line, the key insight, and all hashtags. Output only the revised post — no preamble.\n\n${rawContent}`,
      }],
    });
    rawContent = reviseMsg.content[0].type === 'text' ? reviseMsg.content[0].text.trim() : rawContent;
  }

  const content = injectMentionMarkers(rawContent);

  // Generate first comment text only — URL is appended in code to avoid truncation
  const commentMessage = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `You wrote this LinkedIn post:\n\n${content}\n\nWrite a first comment designed to get people to reply. Output the comment text only.

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

  const commentText = commentMessage.content[0].type === 'text' ? commentMessage.content[0].text.trim() : '';
  const firstComment = commentText;

  const finalWordCount = content.split(/\s+/).filter(Boolean).length;

  // Generate short internal title (3-5 words) for tracking and reporting
  let title = '';
  try {
    const titleMessage = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Give this LinkedIn post a short internal title (3-5 words, no quotes, no punctuation).\n\n${content.split('\n')[0]}`,
      }],
    });
    title = (titleMessage.content[0].type === 'text' ? titleMessage.content[0].text : '').trim();
    console.log(`Post title: ${title}`);
  } catch (err) {
    console.warn(`Title generation failed: ${(err as Error).message}`);
  }

  return {
    content,
    firstComment,
    title,
    postType,
    sourceTitle: item.title,
    sourceUrl: item.link,
    sourceDate: item.pubDate,
    sourceFeed: item.source,
    generatedAt: new Date().toISOString(),
    imageUrl: item.imageUrl,
    wordCount: finalWordCount,
  };
}
