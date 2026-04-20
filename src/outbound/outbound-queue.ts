import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import { getProfileLiftBonus } from '../analytics/attribution.js';
import { getOrganicProfileBonus } from '../analytics/organic-attribution.js';

const STATE_FILE = 'outbound_state.json';
const PROFILES_FILE = 'outbound_profiles.json';

export interface OutboundProfile {
  id: string;
  url: string;
  name: string;       // display name — populated on first scrape if not provided
  addedAt: string;
  active: boolean;
  insider?: boolean;  // true if you work/are affiliated with this org
  colleague?: boolean; // true if this person is a direct colleague — avoid contrarian approaches
  lastSeenPostAt?: string;   // ISO timestamp — last time a fresh post was found
  lastCheckedAt?: string;    // ISO timestamp — last time this profile was scraped
}

export interface PendingComment {
  id: string;
  profileUrl: string;
  profileName: string;
  postUrl: string;
  postSnippet: string;
  postSummary: string;
  postAgeHours: number | null;
  commentOptions: [string, string];
  commentLabels: [string, string];
  recommendationReason: string;
  reasoning: string;
  status: 'pending' | 'posted' | 'skipped';
  selectedOption?: 1 | 2;
  createdAt: string;
  postedAt?: string;
  // Comment-level metrics (scraped by midnight snapshot)
  commentImpressions?: number;
  commentReactions?: number;
  metricsScrapedAt?: string;
}

export interface CandidatePost {
  id: string;
  url: string;
  text: string;
  authorName: string;
  ageHours: number | null;
  profileUrl: string;
  profileName: string;
  insider: boolean;
  colleague: boolean;
  articleUrl?: string;  // external URL from the post's link card
}

interface OutboundState {
  seenPostIds: string[];
  pendingComments: PendingComment[];
  lastPollAt: string | null;
  dailyCount: { date: string; count: number };
  fallbackCandidate: CandidatePost | null;         // legacy — kept for backward compat
  rankedCandidates?: CandidatePost[];               // full ranked list from last poll
  rankedAt?: string | null;                         // ISO timestamp of when list was ranked
}

interface ProfilesStore {
  profiles: OutboundProfile[];
}

function loadState(): OutboundState {
  if (!existsSync(STATE_FILE)) {
    return { seenPostIds: [], pendingComments: [], lastPollAt: null, dailyCount: { date: '', count: 0 }, fallbackCandidate: null };
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  if (!('fallbackCandidate' in state)) state.fallbackCandidate = null;
  return state;
}

function saveState(state: OutboundState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadProfiles(): ProfilesStore {
  if (!existsSync(PROFILES_FILE)) return { profiles: [] };
  return JSON.parse(readFileSync(PROFILES_FILE, 'utf-8'));
}

function saveProfiles(store: ProfilesStore): void {
  writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2));
}

export function normalizeProfileUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}/`;
  } catch {
    return url;
  }
}

export function getActiveProfiles(): OutboundProfile[] {
  return loadProfiles().profiles.filter(p => p.active);
}

export function addProfile(url: string, name: string = ''): { profile: OutboundProfile; existed: boolean } {
  const store = loadProfiles();
  const normalized = normalizeProfileUrl(url);
  const existing = store.profiles.find(p => p.url === normalized);
  if (existing) return { profile: existing, existed: true };

  // Derive a readable placeholder name from the URL slug if none provided
  const slug = url.replace(/\/$/, '').split('/').pop() ?? url;
  const profile: OutboundProfile = {
    id: crypto.randomUUID(),
    url: normalized,
    name: name || slug,
    addedAt: new Date().toISOString(),
    active: true,
  };
  store.profiles.push(profile);
  saveProfiles(store);
  return { profile, existed: false };
}

export function recordProfilePollResult(url: string, hadNewPosts: boolean): void {
  const store = loadProfiles();
  const normalized = normalizeProfileUrl(url);
  const p = store.profiles.find(p => p.url === normalized);
  if (!p) return;
  p.lastCheckedAt = new Date().toISOString();
  if (hadNewPosts) {
    p.lastSeenPostAt = new Date().toISOString();
  }
  saveProfiles(store);
}

/** Returns profiles sorted by priority for checking. Higher priority = checked first.
 *  Priority = hoursSinceLastChecked + frequencyBonus - recentCommentPenalty.
 *  Pass maxProfiles to limit results, or omit to get all. */
export function getProfilesByPriority(maxProfiles?: number): OutboundProfile[] {
  const profiles = getActiveProfiles();
  const now = Date.now();

  const scored = profiles.map(p => {
    const lastChecked = p.lastCheckedAt ? new Date(p.lastCheckedAt).getTime() : 0;
    const hoursSinceChecked = lastChecked === 0 ? 999 : (now - lastChecked) / 3_600_000;

    // Frequency bonus: profiles that have posted recently are more likely to have new content
    const lastSeen = p.lastSeenPostAt ? new Date(p.lastSeenPostAt).getTime() : 0;
    const daysSincePost = lastSeen === 0 ? 30 : (now - lastSeen) / (1000 * 60 * 60 * 24);
    const frequencyBonus = daysSincePost < 2 ? 10 : daysSincePost < 7 ? 5 : 0;

    // Comment cooldown penalty: if we commented on this profile recently, deprioritize checking
    const commentCooldown = hoursSinceLastComment(p.url);
    const commentPenalty = commentCooldown < 24 ? (24 - commentCooldown) * 0.5 : 0; // 1-day cooldown

    const liftBonus = getProfileLiftBonus(p.url);
    const organicBonus = getOrganicProfileBonus(p.url);
    const attributionBonus = Math.max(liftBonus, organicBonus); // use the stronger signal
    const priority = hoursSinceChecked + frequencyBonus - commentPenalty + attributionBonus;
    return { profile: p, priority };
  });

  scored.sort((a, b) => b.priority - a.priority);
  const limited = maxProfiles ? scored.slice(0, maxProfiles) : scored;
  return limited.map(s => s.profile);
}

export function updateProfileName(url: string, name: string): void {
  const store = loadProfiles();
  const normalized = normalizeProfileUrl(url);
  const p = store.profiles.find(p => p.url === normalized);
  if (p && p.name !== name) {
    p.name = name;
    saveProfiles(store);
  }
}

export function isPostSeen(postId: string): boolean {
  return loadState().seenPostIds.includes(postId);
}

export function markPostSeen(postId: string): void {
  const state = loadState();
  if (!state.seenPostIds.includes(postId)) {
    state.seenPostIds.push(postId);
    if (state.seenPostIds.length > 2000) state.seenPostIds = state.seenPostIds.slice(-2000);
    saveState(state);
  }
}

export function getDailyCount(): number {
  const state = loadState();
  if (state.dailyCount.date !== new Date().toDateString()) return 0;
  return state.dailyCount.count;
}

export function incrementDailyCount(): void {
  const state = loadState();
  const today = new Date().toDateString();
  state.dailyCount = state.dailyCount.date === today
    ? { date: today, count: state.dailyCount.count + 1 }
    : { date: today, count: 1 };
  saveState(state);
}

export function addPendingComment(comment: PendingComment): void {
  const state = loadState();
  state.pendingComments.push(comment);
  saveState(state);
}

export function getPendingComment(id: string): PendingComment | null {
  return loadState().pendingComments.find(c => c.id === id) ?? null;
}

export function updateCommentStatus(id: string, updates: Partial<PendingComment>): void {
  const state = loadState();
  const idx = state.pendingComments.findIndex(c => c.id === id);
  if (idx !== -1) {
    state.pendingComments[idx] = { ...state.pendingComments[idx], ...updates };
    saveState(state);
  }
}

export function recordOutboundPoll(): void {
  const state = loadState();
  state.lastPollAt = new Date().toISOString();
  saveState(state);
}

export function storeFallbackCandidate(candidate: CandidatePost | null): void {
  const state = loadState();
  state.fallbackCandidate = candidate;
  saveState(state);
}

/** Returns hours since the most recent posted comment for a given profile URL, or Infinity if none. */
export function hoursSinceLastComment(profileUrl: string): number {
  const state = loadState();
  let latest = 0;
  for (const c of state.pendingComments) {
    if (c.status === 'posted' && c.profileUrl === profileUrl && c.postedAt) {
      const t = new Date(c.postedAt).getTime();
      if (t > latest) latest = t;
    }
  }
  return latest === 0 ? Infinity : (Date.now() - latest) / 3_600_000;
}

export function popFallbackCandidate(): CandidatePost | null {
  const state = loadState();
  // Try ranked list first, fall back to legacy single candidate
  const list = state.rankedCandidates ?? [];
  if (list.length > 0) {
    const candidate = list.shift()!;
    state.rankedCandidates = list;
    state.fallbackCandidate = null;
    saveState(state);
    return candidate;
  }
  const candidate = state.fallbackCandidate ?? null;
  state.fallbackCandidate = null;
  saveState(state);
  return candidate;
}

const RANKED_LIST_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Store the full ranked candidate list after a poll. */
export function storeRankedCandidates(candidates: CandidatePost[]): void {
  const state = loadState();
  state.rankedCandidates = candidates;
  state.rankedAt = new Date().toISOString();
  state.fallbackCandidate = null; // superseded by ranked list
  saveState(state);
}

/** Pop the next candidate from the ranked list. Returns null if list is empty or stale (>15 min). */
export function popNextRankedCandidate(): CandidatePost | null {
  const state = loadState();
  const list = state.rankedCandidates ?? [];
  const rankedAt = state.rankedAt ? new Date(state.rankedAt).getTime() : 0;

  if (list.length === 0 || (Date.now() - rankedAt) > RANKED_LIST_TTL_MS) {
    return null; // list is empty or stale — caller should do a full poll
  }

  const candidate = list.shift()!;
  state.rankedCandidates = list;
  saveState(state);
  return candidate;
}

/** Check if a fresh ranked list exists (within TTL and non-empty). */
export function hasRankedCandidates(): boolean {
  const state = loadState();
  const list = state.rankedCandidates ?? [];
  const rankedAt = state.rankedAt ? new Date(state.rankedAt).getTime() : 0;
  return list.length > 0 && (Date.now() - rankedAt) <= RANKED_LIST_TTL_MS;
}
