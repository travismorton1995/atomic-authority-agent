// Organic follow attribution — delta-impression-weighted decay model.
// Fractionally attributes each day's follower growth across recent posts and comments
// using daily impression deltas (not cumulative) convolved with an exponential decay
// that models the delay between content exposure and follow action.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { PendingComment } from '../outbound/outbound-queue.js';

// --- Configuration ---

const ATTRIBUTION_RETENTION_DAYS = 90;
const POST_SNAPSHOT_DAYS = 90;      // track post impressions — matches metrics scrape window
const COMMENT_SNAPSHOT_DAYS = 15;   // track comment impressions for 15 days
const SNAPSHOT_BUFFER_DAYS = 1;     // keep 1 extra day for delta computation

const ATTRIBUTION_FILE = 'organic_attribution.json';
const SNAPSHOTS_FILE = 'impression_snapshots.json';
const HISTORY_FILE = 'posted_history.json';
const STATE_FILE = 'outbound_state.json';
const FOLLOWERS_FILE = 'follower_history.json';

// --- Types ---

export interface AttributionItem {
  type: 'post' | 'comment';
  id: string;
  date: string;                  // YYYY-MM-DD when published/posted
  impressions: number;           // total delta impressions within attribution window
  ageInDays: number;             // age of item on the attribution day
  rawWeight: number;
  normalizedWeight: number;
  attributedFollows: number;
  label: string;
}

export interface DailyAttribution {
  date: string;
  followerDelta: number;
  unattributed: number;
  items: AttributionItem[];
}

export interface PostRollupEntry {
  id: string;
  label: string;
  totalAttributed: number;
  linkedInAttributed: number;
}

export interface ProfileRollupEntry {
  profileUrl: string;
  profileName: string;
  totalAttributed: number;
  commentCount: number;
}

export interface OrganicAttributionData {
  lastComputed: string;
  dailyAttributions: DailyAttribution[];
  postRollup: PostRollupEntry[];
  profileRollup: ProfileRollupEntry[];
}

// Compact tuple format: [YYYY-MM-DD, cumulativeImpressions, cumulativeNewFollowers?]
// Posts store all 3 elements; comments only store [date, impressions].
// Keyed by "post:{id}" or "comment:{id}"
type SnapshotTuple = [string, number] | [string, number, number];
type ImpressionSnapshots = Record<string, SnapshotTuple[]>;

// --- Helpers ---

function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + 'T12:00:00');
  const b = new Date(dateB + 'T12:00:00');
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/** Get the delta impressions and delta direct follows for an item on a specific date. */
function getDeltas(itemKey: string, date: string, snapshots: ImpressionSnapshots): { impressions: number; directFollows: number } {
  const series = snapshots[itemKey];
  if (!series || series.length < 2) return { impressions: 0, directFollows: 0 };

  for (let i = 1; i < series.length; i++) {
    if (series[i][0] === date) {
      const impressions = Math.max(0, series[i][1] - series[i - 1][1]);
      const currFollows = series[i][2] ?? 0;
      const prevFollows = series[i - 1][2] ?? 0;
      const directFollows = Math.max(0, currFollows - prevFollows);
      return { impressions, directFollows };
    }
  }
  return { impressions: 0, directFollows: 0 };
}

// --- Impression Snapshots ---

function loadImpressionSnapshots(): ImpressionSnapshots {
  if (!existsSync(SNAPSHOTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveImpressionSnapshots(snapshots: ImpressionSnapshots): void {
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots));
}

/** Record today's cumulative impressions for recent posts and comments. */
function recordImpressionSnapshots(
  posts: PostForAttribution[],
  comments: CommentForAttribution[],
): ImpressionSnapshots {
  const today = todayET();
  const snapshots = loadImpressionSnapshots();

  // Posts: track impressions + newFollowers, within last 90 days
  for (const post of posts) {
    if (daysBetween(post.publishedDate, today) > POST_SNAPSHOT_DAYS) continue;
    const key = `post:${post.id}`;
    if (!snapshots[key]) snapshots[key] = [];
    const series = snapshots[key];
    const tuple: SnapshotTuple = [today, post.impressions, post.newFollowers];
    if (series.length === 0 || series[series.length - 1][0] !== today) {
      series.push(tuple);
    } else {
      series[series.length - 1] = tuple; // update if re-run
    }
  }

  // Comments: only track those posted within last 15 days
  for (const comment of comments) {
    if (daysBetween(comment.postedDate, today) > COMMENT_SNAPSHOT_DAYS) continue;
    const key = `comment:${comment.id}`;
    if (!snapshots[key]) snapshots[key] = [];
    const series = snapshots[key];
    if (series.length === 0 || series[series.length - 1][0] !== today) {
      series.push([today, comment.impressions]);
    } else {
      series[series.length - 1][1] = comment.impressions;
    }
  }

  // Prune: only need today + yesterday for delta computation, and remove expired items
  const maxSnapshotAge = SNAPSHOT_BUFFER_DAYS + 1; // keep 2 days of snapshots
  for (const [key, series] of Object.entries(snapshots)) {
    snapshots[key] = series.filter(([date]) => daysBetween(date, today) <= maxSnapshotAge);
    if (snapshots[key].length === 0) delete snapshots[key];
  }

  saveImpressionSnapshots(snapshots);
  return snapshots;
}


// --- Data Loading ---

interface FollowerSnapshot { date: string; total: number; }

function loadFollowerSnapshots(): FollowerSnapshot[] {
  if (!existsSync(FOLLOWERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(FOLLOWERS_FILE, 'utf-8')) as FollowerSnapshot[];
  } catch { return []; }
}

interface PostForAttribution {
  id: string;
  publishedDate: string;
  impressions: number;
  newFollowers: number;
  label: string;
}

function loadRecentPosts(): PostForAttribution[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const posts: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    return posts
      .filter(p => p.status === 'published' && p.publishedAt && p.metrics)
      .map(p => ({
        id: p.id,
        publishedDate: toETDate(p.publishedAt),
        impressions: p.metrics?.impressions ?? 0,
        newFollowers: p.metrics?.newFollowers ?? 0,
        label: (p.draft?.sourceTitle ?? p.finalContent ?? '').slice(0, 60),
      }));
  } catch { return []; }
}

interface CommentForAttribution {
  id: string;
  postedDate: string;
  impressions: number;
  profileUrl: string;
  profileName: string;
  postUrl: string;
}

function loadRecentComments(): CommentForAttribution[] {
  if (!existsSync(STATE_FILE)) return [];

  const ownPostUrls = new Set<string>();
  if (existsSync(HISTORY_FILE)) {
    try {
      const posts: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      for (const p of posts) {
        if (p.linkedInPostUrl) ownPostUrls.add(p.linkedInPostUrl);
      }
    } catch { /* graceful degradation */ }
  }

  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const comments: PendingComment[] = state.pendingComments ?? [];
    return comments
      .filter(c => {
        if (c.status !== 'posted' || !c.postedAt) return false;
        if (ownPostUrls.has(c.postUrl)) return false;
        return true;
      })
      .map(c => ({
        id: c.id,
        postedDate: toETDate(c.postedAt!),
        impressions: c.commentImpressions ?? 0,
        profileUrl: c.profileUrl,
        profileName: c.profileName,
        postUrl: c.postUrl,
      }));
  } catch { return []; }
}

function loadExistingAttribution(): OrganicAttributionData {
  if (!existsSync(ATTRIBUTION_FILE)) {
    return { lastComputed: '', dailyAttributions: [], postRollup: [], profileRollup: [] };
  }
  try {
    return JSON.parse(readFileSync(ATTRIBUTION_FILE, 'utf-8'));
  } catch {
    return { lastComputed: '', dailyAttributions: [], postRollup: [], profileRollup: [] };
  }
}

// --- Core Attribution ---

/**
 * Attribute a single day's follower delta using direct-follow-discounted impressions.
 *
 * 1. Compute the day's impressions-per-follow ratio: totalImpressions / followerDelta
 * 2. For each post: discountedWeight = deltaImpressions - (dailyDirectFollows × ratio)
 *    This reduces credit for posts whose impressions already converted directly.
 * 3. indirectPool = followerDelta - sum(dailyDirectFollows)
 * 4. Distribute indirectPool proportionally by discounted weights.
 * 5. Each post's total attributed = directFollows + proportional share of indirectPool.
 *
 * Comments have no direct follows so they participate at full impression weight.
 * Once computed, a day's attribution is permanent — never revisited.
 */
function attributeDay(
  date: string,
  followerDelta: number,
  posts: PostForAttribution[],
  comments: CommentForAttribution[],
  snapshots: ImpressionSnapshots,
): DailyAttribution {
  const items: AttributionItem[] = [];
  let hasDeltaData = false;
  let totalDeltaImpressions = 0;
  let totalDirectFollows = 0;

  // Collect post deltas (impressions + direct follows)
  const postDeltas: Array<{ post: PostForAttribution; impressions: number; directFollows: number }> = [];
  for (const post of posts) {
    const d = getDeltas(`post:${post.id}`, date, snapshots);
    if (d.impressions > 0) hasDeltaData = true;
    if (d.impressions <= 0 && d.directFollows <= 0) continue;
    postDeltas.push({ post, impressions: d.impressions, directFollows: d.directFollows });
    totalDeltaImpressions += d.impressions;
    totalDirectFollows += d.directFollows;
  }

  // Collect comment deltas (impressions only — no direct follows)
  const commentDeltas: Array<{ comment: CommentForAttribution; impressions: number }> = [];
  for (const comment of comments) {
    const d = getDeltas(`comment:${comment.id}`, date, snapshots);
    if (d.impressions > 0) hasDeltaData = true;
    if (d.impressions <= 0) continue;
    commentDeltas.push({ comment, impressions: d.impressions });
    totalDeltaImpressions += d.impressions;
  }

  // Fallback: use cumulative impressions if no snapshot deltas exist.
  // Direct follows are set to 0 because we only have cumulative totals, not daily deltas.
  // The discount formula only works correctly with actual daily deltas.
  if (!hasDeltaData) {
    for (const post of posts) {
      if (post.publishedDate > date || post.impressions <= 0) continue;
      postDeltas.push({ post, impressions: post.impressions, directFollows: 0 });
      totalDeltaImpressions += post.impressions;
    }
    for (const comment of comments) {
      if (comment.postedDate > date || comment.impressions <= 0) continue;
      commentDeltas.push({ comment, impressions: comment.impressions });
      totalDeltaImpressions += comment.impressions;
    }
  }

  // Compute impressions-per-follow ratio for discounting
  const ratio = followerDelta > 0 ? totalDeltaImpressions / followerDelta : 0;
  const indirectPool = Math.max(0, followerDelta - totalDirectFollows);

  // Build items with discounted weights
  for (const { post, impressions, directFollows } of postDeltas) {
    const discountedWeight = Math.max(0, impressions - directFollows * ratio);
    items.push({
      type: 'post', id: post.id, date: post.publishedDate,
      impressions, ageInDays: daysBetween(post.publishedDate, date),
      rawWeight: discountedWeight, normalizedWeight: 0,
      attributedFollows: directFollows, // start with direct, indirect added below
      label: post.label,
    });
  }

  for (const { comment, impressions } of commentDeltas) {
    items.push({
      type: 'comment', id: comment.id, date: comment.postedDate,
      impressions, ageInDays: daysBetween(comment.postedDate, date),
      rawWeight: impressions, // no discount — comments have no direct follows
      normalizedWeight: 0, attributedFollows: 0,
      label: `Comment on ${comment.profileName}`,
    });
  }

  // Distribute indirect pool by discounted weights
  const totalWeight = items.reduce((s, i) => s + i.rawWeight, 0);
  let unattributed = 0;

  if (totalWeight > 0 && indirectPool > 0) {
    for (const item of items) {
      item.normalizedWeight = item.rawWeight / totalWeight;
      item.attributedFollows += indirectPool * item.normalizedWeight;
    }
  } else if (indirectPool > 0) {
    unattributed = indirectPool;
  }

  return { date, followerDelta, unattributed, items };
}

// --- Rollups ---

function buildPostRollup(attributions: DailyAttribution[], posts: PostForAttribution[]): PostRollupEntry[] {
  const totals = new Map<string, { label: string; attributed: number; liAttributed: number }>();

  for (const day of attributions) {
    for (const item of day.items) {
      if (item.type !== 'post') continue;
      const existing = totals.get(item.id);
      if (existing) {
        existing.attributed += item.attributedFollows;
      } else {
        totals.set(item.id, { label: item.label, attributed: item.attributedFollows, liAttributed: 0 });
      }
    }
  }

  for (const post of posts) {
    const entry = totals.get(post.id);
    if (entry) entry.liAttributed = post.newFollowers;
  }

  return Array.from(totals.entries())
    .map(([id, { label, attributed, liAttributed }]) => ({
      id,
      label,
      totalAttributed: Math.round(attributed * 100) / 100,
      linkedInAttributed: liAttributed,
    }))
    .sort((a, b) => b.totalAttributed - a.totalAttributed);
}

function buildProfileRollup(attributions: DailyAttribution[], comments: CommentForAttribution[]): ProfileRollupEntry[] {
  const totals = new Map<string, { profileName: string; attributed: number; commentIds: Set<string> }>();

  for (const day of attributions) {
    for (const item of day.items) {
      if (item.type !== 'comment') continue;
      const comment = comments.find(c => c.id === item.id);
      if (!comment) continue;

      const existing = totals.get(comment.profileUrl);
      if (existing) {
        existing.attributed += item.attributedFollows;
        existing.commentIds.add(item.id);
      } else {
        totals.set(comment.profileUrl, {
          profileName: comment.profileName,
          attributed: item.attributedFollows,
          commentIds: new Set([item.id]),
        });
      }
    }
  }

  return Array.from(totals.entries())
    .map(([profileUrl, { profileName, attributed, commentIds }]) => ({
      profileUrl,
      profileName,
      totalAttributed: Math.round(attributed * 100) / 100,
      commentCount: commentIds.size,
    }))
    .sort((a, b) => b.totalAttributed - a.totalAttributed);
}

// --- Public API ---

/**
 * Compute organic attribution for the most recent day(s) not yet computed.
 * Records impression snapshots first, then uses delta impressions for attribution.
 * Historical days (computed before delta data was available) are preserved as-is.
 */
export function computeAndSaveAttribution(): void {
  const followerSnapshots = loadFollowerSnapshots();
  if (followerSnapshots.length < 2) {
    console.log('[attribution] Need at least 2 follower snapshots — skipping.');
    return;
  }

  const posts = loadRecentPosts();
  const comments = loadRecentComments();

  // Record today's impression snapshots (must happen before attribution)
  const impressionSnaps = recordImpressionSnapshots(posts, comments);

  const existing = loadExistingAttribution();
  const computedDates = new Set(existing.dailyAttributions.map(d => d.date));

  const newAttributions: DailyAttribution[] = [];

  for (let i = 1; i < followerSnapshots.length; i++) {
    const date = followerSnapshots[i].date;
    if (computedDates.has(date)) continue;

    const delta = followerSnapshots[i].total - followerSnapshots[i - 1].total;
    const attribution = attributeDay(date, delta, posts, comments, impressionSnaps);
    newAttributions.push(attribution);
  }

  if (newAttributions.length === 0) {
    console.log('[attribution] No new days to compute.');
    return;
  }

  const allAttributions = [...existing.dailyAttributions, ...newAttributions];

  // Prune older than retention period
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ATTRIBUTION_RETENTION_DAYS);
  const cutoff = cutoffDate.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  const retained = allAttributions.filter(d => d.date >= cutoff);

  const postRollup = buildPostRollup(retained, posts);
  const profileRollup = buildProfileRollup(retained, comments);

  const data: OrganicAttributionData = {
    lastComputed: new Date().toISOString(),
    dailyAttributions: retained,
    postRollup,
    profileRollup,
  };

  writeFileSync(ATTRIBUTION_FILE, JSON.stringify(data, null, 2));
  console.log(`[attribution] Computed ${newAttributions.length} new day(s), ${retained.length} total retained. Snapshots: ${Object.keys(impressionSnaps).length} items tracked.`);
}

/**
 * Load the organic attribution data for reporting.
 */
export function getOrganicAttribution(): OrganicAttributionData | null {
  if (!existsSync(ATTRIBUTION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ATTRIBUTION_FILE, 'utf-8'));
  } catch { return null; }
}

/**
 * Get a summary of organic attribution for the last N days (for the weekly report).
 */
export function getOrganicAttributionSummary(days: number = 14): {
  totalGrowth: number;
  postAttributed: number;
  commentAttributed: number;
  unattributed: number;
  topPosts: PostRollupEntry[];
  topProfiles: ProfileRollupEntry[];
} | null {
  const data = getOrganicAttribution();
  if (!data || data.dailyAttributions.length === 0) return null;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  const recent = data.dailyAttributions.filter(d => d.date >= cutoff);
  if (recent.length === 0) return null;

  let postAttributed = 0;
  let commentAttributed = 0;
  let unattributed = 0;
  let totalGrowth = 0;

  const postTotals = new Map<string, { label: string; attributed: number; liAttributed: number }>();
  const profileTotals = new Map<string, { profileName: string; attributed: number; commentIds: Set<string> }>();

  for (const day of recent) {
    totalGrowth += day.followerDelta;
    unattributed += day.unattributed;

    for (const item of day.items) {
      if (item.type === 'post') {
        postAttributed += item.attributedFollows;
        const existing = postTotals.get(item.id);
        if (existing) {
          existing.attributed += item.attributedFollows;
        } else {
          const fullRollup = data.postRollup.find(r => r.id === item.id);
          postTotals.set(item.id, {
            label: item.label,
            attributed: item.attributedFollows,
            liAttributed: fullRollup?.linkedInAttributed ?? 0,
          });
        }
      } else {
        commentAttributed += item.attributedFollows;
        const profileName = item.label.replace('Comment on ', '');
        const fullProfile = data.profileRollup.find(r => r.profileName === profileName);
        const profileUrl = fullProfile?.profileUrl ?? '';
        const existing = profileTotals.get(profileUrl || profileName);
        if (existing) {
          existing.attributed += item.attributedFollows;
          existing.commentIds.add(item.id);
        } else {
          profileTotals.set(profileUrl || profileName, {
            profileName,
            attributed: item.attributedFollows,
            commentIds: new Set([item.id]),
          });
        }
      }
    }
  }

  const topPosts = Array.from(postTotals.entries())
    .map(([id, { label, attributed, liAttributed }]) => ({
      id,
      label,
      totalAttributed: Math.round(attributed * 100) / 100,
      linkedInAttributed: liAttributed,
    }))
    .sort((a, b) => b.totalAttributed - a.totalAttributed)
    .slice(0, 5);

  const topProfiles = Array.from(profileTotals.entries())
    .map(([key, { profileName, attributed, commentIds }]) => ({
      profileUrl: key,
      profileName,
      totalAttributed: Math.round(attributed * 100) / 100,
      commentCount: commentIds.size,
    }))
    .sort((a, b) => b.totalAttributed - a.totalAttributed)
    .slice(0, 5);

  return {
    totalGrowth,
    postAttributed: Math.round(postAttributed * 100) / 100,
    commentAttributed: Math.round(commentAttributed * 100) / 100,
    unattributed: Math.round(unattributed * 100) / 100,
    topPosts,
    topProfiles,
  };
}

// --- Profile bonus for outbound selection ---

let cachedProfileBonus: Map<string, number> | null = null;
let bonusCacheTimestamp = 0;
const BONUS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function refreshProfileBonusCache(): Map<string, number> {
  if (cachedProfileBonus && Date.now() - bonusCacheTimestamp < BONUS_CACHE_TTL_MS) {
    return cachedProfileBonus;
  }

  cachedProfileBonus = new Map();
  try {
    const data = getOrganicAttribution();
    if (!data) return cachedProfileBonus;

    for (const profile of data.profileRollup) {
      if (profile.commentCount > 0) {
        // Indirect follows per comment — the core efficiency metric
        const perComment = profile.totalAttributed / profile.commentCount;
        cachedProfileBonus.set(profile.profileUrl, perComment);
      }
    }
  } catch { /* graceful */ }

  bonusCacheTimestamp = Date.now();
  return cachedProfileBonus;
}

/**
 * Returns a priority bonus for a profile based on its organic follow attribution.
 * Profiles whose comments generate more indirect follows per comment get higher bonuses.
 * Clamped to [0, 15] to avoid dominating the priority score.
 *
 * Scale: 0.1 indirect follows/comment → bonus of ~3, 0.5 → ~15 (max).
 */
export function getOrganicProfileBonus(profileUrl: string): number {
  const cache = refreshProfileBonusCache();
  const perComment = cache.get(profileUrl);
  if (!perComment || perComment <= 0) return 0;

  // Scale: multiply by 30 so that 0.5 follows/comment → 15 (max)
  const bonus = perComment * 30;
  return Math.max(0, Math.min(15, bonus));
}
