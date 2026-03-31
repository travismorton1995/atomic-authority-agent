import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

const STATE_FILE = 'outbound_state.json';
const PROFILES_FILE = 'outbound_profiles.json';

export interface OutboundProfile {
  id: string;
  url: string;
  name: string;       // display name — populated on first scrape if not provided
  addedAt: string;
  active: boolean;
}

export interface PendingComment {
  id: string;
  profileUrl: string;
  profileName: string;
  postUrl: string;
  postSnippet: string;
  commentOptions: [string, string];
  commentLabels: [string, string];
  recommendationReason: string;
  reasoning: string;
  status: 'pending' | 'posted' | 'skipped';
  selectedOption?: 1 | 2;
  createdAt: string;
  postedAt?: string;
}

interface OutboundState {
  seenPostIds: string[];
  pendingComments: PendingComment[];
  lastPollAt: string | null;
  dailyCount: { date: string; count: number };
}

interface ProfilesStore {
  profiles: OutboundProfile[];
}

function loadState(): OutboundState {
  if (!existsSync(STATE_FILE)) {
    return { seenPostIds: [], pendingComments: [], lastPollAt: null, dailyCount: { date: '', count: 0 } };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
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
