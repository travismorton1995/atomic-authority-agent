// Company/org mention dictionary for LinkedIn @mentions.
// Data stored in mentions.json — read fresh on every call so changes
// from test-mentions are picked up without a rebuild or restart.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MENTIONS_FILE = resolve(process.cwd(), 'mentions.json');
const BLOCKLIST_FILE = resolve(process.cwd(), 'mentions_blocklist.json');

export interface MentionEntry {
  searchTerm: string;  // what to type after @ in the LinkedIn composer
  verified: boolean;
}

// ── Load / Save ──────────────────────────────────────────────────────

function loadMentions(): Record<string, MentionEntry> {
  if (!existsSync(MENTIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MENTIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMentions(mentions: Record<string, MentionEntry>): void {
  // Sort: verified first (alphabetical), then unverified
  const entries = Object.entries(mentions);
  const verified = entries.filter(([, v]) => v.verified).sort(([a], [b]) => a.localeCompare(b));
  const unverified = entries.filter(([, v]) => !v.verified).sort(([a], [b]) => a.localeCompare(b));
  const sorted = Object.fromEntries([...verified, ...unverified]);
  writeFileSync(MENTIONS_FILE, JSON.stringify(sorted, null, 2), 'utf-8');
}

// ── Blocklist ────────────────────────────────────────────────────────

function loadBlocklist(): Set<string> {
  if (!existsSync(BLOCKLIST_FILE)) return new Set();
  try {
    const list = JSON.parse(readFileSync(BLOCKLIST_FILE, 'utf-8')) as string[];
    return new Set(list.map(s => s.toLowerCase()));
  } catch { return new Set(); }
}

export function addToBlocklist(name: string): void {
  const blocked = loadBlocklist();
  blocked.add(name.toLowerCase());
  writeFileSync(BLOCKLIST_FILE, JSON.stringify([...blocked].sort(), null, 2), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────────

/** Returns only verified entries — used during posting and mention injection. */
export function verifiedMentions(): Record<string, MentionEntry> {
  const all = loadMentions();
  return Object.fromEntries(
    Object.entries(all).filter(([, entry]) => entry.verified)
  );
}

/** Returns all entries including unverified — used by test-mentions. */
export function allMentions(): Record<string, MentionEntry> {
  return loadMentions();
}

/** Appends newly discovered company names as unverified entries. */
export function addUnverifiedMentions(names: string[]): void {
  const mentions = loadMentions();
  const existingKeys = new Set(Object.keys(mentions).map(k => k.toLowerCase()));
  const blocked = loadBlocklist();
  const toAdd = names.filter(n => n.length > 2 && !existingKeys.has(n.toLowerCase()) && !blocked.has(n.toLowerCase()));
  if (toAdd.length === 0) return;

  for (const name of toAdd) {
    mentions[name] = { searchTerm: name, verified: false };
  }

  saveMentions(mentions);
  console.log(`Mentions: added ${toAdd.length} unverified — ${toAdd.join(', ')}`);
}

/** Mark an entry as verified with a confirmed search term. */
export function verifyMention(name: string, searchTerm: string): void {
  const mentions = loadMentions();
  if (name in mentions) {
    mentions[name] = { searchTerm, verified: true };
    saveMentions(mentions);
  }
}

/** Remove an entry and add to blocklist. */
export function removeMentionEntry(name: string): void {
  const mentions = loadMentions();
  if (!(name in mentions)) {
    console.warn(`  Could not find entry for "${name}" to remove.`);
    return;
  }
  delete mentions[name];
  saveMentions(mentions);
  addToBlocklist(name);
  console.log(`  Removed "${name}" and added to blocklist.`);
}

/** Get unverified entries for test-mentions. */
export function getUnverifiedMentions(): Array<{ name: string; searchTerm: string }> {
  const mentions = loadMentions();
  return Object.entries(mentions)
    .filter(([, v]) => !v.verified)
    .map(([name, v]) => ({ name, searchTerm: v.searchTerm }));
}
