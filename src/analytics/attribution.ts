// Outbound comment attribution — correlates comment activity with follower growth.
// Joins follower_history.json (daily snapshots) with outbound_state.json (posted comments)
// to estimate per-profile "lift" on follower deltas.

import { readFileSync, existsSync } from 'fs';
import { robustAverage, confidenceWeightedScore, type Confidence } from './stats.js';
import { getFollowerData, type FollowerSnapshot } from './followers.js';
import { getActiveProfiles } from '../outbound/outbound-queue.js';

const OUTBOUND_STATE_FILE = 'outbound_state.json';
const POSTED_HISTORY_FILE = 'posted_history.json';

export interface DailyLedgerEntry {
  date: string;              // YYYY-MM-DD
  followerDelta: number;     // today.total - yesterday.total
  commentCount: number;      // outbound comments posted this day
  commentedProfiles: string[]; // profile URLs commented on
  hadOwnPost: boolean;       // whether an own post was published
}

export interface ProfileLiftScore {
  profileUrl: string;
  profileName: string;
  lift: number;              // avg delta on commented days minus baseline
  avgDeltaCommented: number;
  commentDays: number;
  confidence: Confidence;
  insider: boolean;
  colleague: boolean;
}

export interface AttributionSummary {
  totalDays: number;
  totalCommentDays: number;
  totalQuietDays: number;
  avgDeltaCommentDays: number;
  avgDeltaQuietDays: number;
  overallLift: number;
  overallConfidence: Confidence;
  controlledLift: number;       // excluding own-post days
  controlledConfidence: Confidence;
  profileScores: ProfileLiftScore[];
}

function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

/** Load posted comments from outbound_state.json, grouped by ET date. */
function loadPostedCommentsByDate(): Map<string, string[]> {
  const byDate = new Map<string, string[]>();
  if (!existsSync(OUTBOUND_STATE_FILE)) return byDate;

  try {
    const state = JSON.parse(readFileSync(OUTBOUND_STATE_FILE, 'utf-8'));
    const comments: any[] = state.pendingComments ?? [];

    for (const c of comments) {
      if (c.status !== 'posted' || !c.postedAt) continue;
      const date = toETDate(c.postedAt);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(c.profileUrl);
    }
  } catch { /* graceful degradation */ }

  return byDate;
}

/** Load own-post publish dates from posted_history.json. */
function loadOwnPostDates(): Set<string> {
  const dates = new Set<string>();
  if (!existsSync(POSTED_HISTORY_FILE)) return dates;

  try {
    const posts: any[] = JSON.parse(readFileSync(POSTED_HISTORY_FILE, 'utf-8'));
    for (const p of posts) {
      if (p.publishedAt) dates.add(toETDate(p.publishedAt));
    }
  } catch { /* graceful degradation */ }

  return dates;
}

/** Build a day-by-day ledger joining follower deltas with comment activity. */
export function buildDailyLedger(): DailyLedgerEntry[] {
  const followerData = getFollowerData();
  if (!followerData || followerData.snapshots.length < 2) return [];

  const snapshots = followerData.snapshots;
  const commentsByDate = loadPostedCommentsByDate();
  const ownPostDates = loadOwnPostDates();

  const ledger: DailyLedgerEntry[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const date = snapshots[i].date;
    const delta = snapshots[i].total - snapshots[i - 1].total;
    const profiles = commentsByDate.get(date) ?? [];

    ledger.push({
      date,
      followerDelta: delta,
      commentCount: profiles.length,
      commentedProfiles: [...new Set(profiles)], // dedupe same profile commented multiple times
      hadOwnPost: ownPostDates.has(date),
    });
  }

  return ledger;
}

/** Compute per-profile lift scores from the daily ledger. */
export function getProfileLiftScores(ledger: DailyLedgerEntry[]): ProfileLiftScore[] {
  if (ledger.length < 5) return [];

  // Collect all unique profile URLs that were commented on
  const allProfileUrls = new Set<string>();
  for (const entry of ledger) {
    for (const url of entry.commentedProfiles) allProfileUrls.add(url);
  }

  // Look up display names from outbound profiles
  const profiles = getActiveProfiles();
  const profileMap = new Map(profiles.map(p => [p.url, p]));

  const scores: ProfileLiftScore[] = [];

  for (const url of allProfileUrls) {
    const commentedDeltas: number[] = [];
    const nonCommentedDeltas: number[] = [];

    for (const entry of ledger) {
      if (entry.commentedProfiles.includes(url)) {
        commentedDeltas.push(entry.followerDelta);
      } else {
        nonCommentedDeltas.push(entry.followerDelta);
      }
    }

    // Need at least 2 comment-days to compute anything meaningful
    if (commentedDeltas.length < 2) continue;

    const avgCommented = robustAverage(commentedDeltas);
    const baseline = nonCommentedDeltas.length > 0 ? robustAverage(nonCommentedDeltas) : 0;
    const lift = avgCommented - baseline;

    const cws = confidenceWeightedScore(commentedDeltas);
    const profile = profileMap.get(url);

    scores.push({
      profileUrl: url,
      profileName: profile?.name ?? url.split('/').filter(Boolean).pop() ?? url,
      lift,
      avgDeltaCommented: avgCommented,
      commentDays: commentedDeltas.length,
      confidence: cws.confidence,
      insider: profile?.insider ?? false,
      colleague: profile?.colleague ?? false,
    });
  }

  scores.sort((a, b) => b.lift - a.lift);
  return scores;
}

/** Full attribution summary for the report. */
export function getAttributionSummary(): AttributionSummary {
  const ledger = buildDailyLedger();

  const commentDays = ledger.filter(e => e.commentCount > 0);
  const quietDays = ledger.filter(e => e.commentCount === 0);

  const commentDeltas = commentDays.map(e => e.followerDelta);
  const quietDeltas = quietDays.map(e => e.followerDelta);

  const avgComment = commentDeltas.length > 0 ? robustAverage(commentDeltas) : 0;
  const avgQuiet = quietDeltas.length > 0 ? robustAverage(quietDeltas) : 0;
  const overallLift = avgComment - avgQuiet;
  const overallCws = confidenceWeightedScore(commentDeltas);

  // Controlled: exclude own-post days to isolate outbound effect
  const controlledComment = commentDays.filter(e => !e.hadOwnPost);
  const controlledQuiet = quietDays.filter(e => !e.hadOwnPost);
  const controlledCommentDeltas = controlledComment.map(e => e.followerDelta);
  const controlledQuietDeltas = controlledQuiet.map(e => e.followerDelta);

  const avgControlledComment = controlledCommentDeltas.length > 0 ? robustAverage(controlledCommentDeltas) : 0;
  const avgControlledQuiet = controlledQuietDeltas.length > 0 ? robustAverage(controlledQuietDeltas) : 0;
  const controlledLift = avgControlledComment - avgControlledQuiet;
  const controlledCws = confidenceWeightedScore(controlledCommentDeltas);

  const profileScores = getProfileLiftScores(ledger);

  return {
    totalDays: ledger.length,
    totalCommentDays: commentDays.length,
    totalQuietDays: quietDays.length,
    avgDeltaCommentDays: avgComment,
    avgDeltaQuietDays: avgQuiet,
    overallLift,
    overallConfidence: overallCws.confidence,
    controlledLift,
    controlledConfidence: controlledCws.confidence,
    profileScores,
  };
}

// --- Lift bonus for profile prioritization ---

let cachedScores: Map<string, ProfileLiftScore> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function refreshCache(): Map<string, ProfileLiftScore> {
  if (cachedScores && Date.now() - cacheTimestamp < CACHE_TTL_MS) return cachedScores;

  try {
    const summary = getAttributionSummary();
    cachedScores = new Map(summary.profileScores.map(s => [s.profileUrl, s]));
  } catch {
    cachedScores = new Map();
  }
  cacheTimestamp = Date.now();
  return cachedScores;
}

/**
 * Returns a priority bonus for a profile based on its follower lift.
 * Low-confidence profiles get 0. Medium gets 50% of lift. High gets 100%.
 * Clamped to [0, 15] to avoid dominating the priority score.
 */
export function getProfileLiftBonus(profileUrl: string): number {
  const scores = refreshCache();
  const score = scores.get(profileUrl);
  if (!score) return 0;

  const damper = score.confidence === 'high' ? 1.0
    : score.confidence === 'medium' ? 0.5
    : 0; // low confidence → no bonus

  if (damper === 0) return 0;

  const bonus = score.lift * damper;
  return Math.max(0, Math.min(15, bonus));
}
