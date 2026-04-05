// Company/org mention dictionary for LinkedIn @mentions.
// Each entry maps a canonical display name (as it might appear in post text)
// to the search term to type after `@` that reliably surfaces the correct
// LinkedIn autocomplete result as the first option.
//
// `verified` is set to true only after manually confirming via `npm run test-mentions`.
// Unverified entries are ignored during posting.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MENTIONS_FILE = resolve(process.cwd(), 'src/poster/mentions.ts');
const BLOCKLIST_FILE = resolve(process.cwd(), 'mentions_blocklist.json');

// Names that were explicitly rejected via test-mentions and should never be re-added.
function loadBlocklist(): Set<string> {
  if (!existsSync(BLOCKLIST_FILE)) return new Set();
  try {
    const list = JSON.parse(readFileSync(BLOCKLIST_FILE, 'utf-8')) as string[];
    return new Set(list.map(s => s.toLowerCase()));
  } catch { return new Set(); }
}

function addToBlocklist(name: string): void {
  const blocked = loadBlocklist();
  blocked.add(name.toLowerCase());
  writeFileSync(BLOCKLIST_FILE, JSON.stringify([...blocked].sort(), null, 2), 'utf-8');
}

export interface MentionEntry {
  searchTerm: string;  // what to type after @ in the LinkedIn composer
  verified: boolean;
}

export const MENTIONS: Record<string, MentionEntry> = {
  'Bruce Power':                           { searchTerm: 'Bruce Power',                     verified: true },
  'Canadian Nuclear Safety Commission':    { searchTerm: 'Canadian Nuclear Safety',         verified: true },
  'CNSC':                                  { searchTerm: 'Canadian Nuclear Safety',         verified: true },
  'Canadian Nuclear Laboratories':         { searchTerm: 'Canadian Nuclear Laboratories',   verified: true },
  'CNL':                                   { searchTerm: 'Canadian Nuclear Laboratories',   verified: true },
  'Ontario Power Generation':              { searchTerm: 'Ontario Power Generation',        verified: true },
  'OPG':                                   { searchTerm: 'Ontario Power Generation',        verified: true },
  'Nuclear Promise X':                     { searchTerm: 'Nuclear Promise X',               verified: true },
  'NPX':                                   { searchTerm: 'Nuclear Promise X',               verified: true },
  'AtkinsRéalis':                          { searchTerm: 'AtkinsRéalis',                    verified: true },
  'Westinghouse':                          { searchTerm: 'Westinghouse Electric Company',   verified: true },
  'NuScale':                               { searchTerm: 'NuScale Power',                   verified: true },
  'TerraPower':                            { searchTerm: 'TerraPower',                      verified: true },
  'X-energy':                              { searchTerm: 'X-energy',                        verified: true },
  'Global First Power':                    { searchTerm: 'Global First Power',              verified: true },
  'New Brunswick Power':                   { searchTerm: 'NB Power',                        verified: true },
  'Canadian Nuclear Association':          { searchTerm: 'Canadian Nuclear Association',    verified: true },
  'CNA':                                   { searchTerm: 'Canadian Nuclear Association',    verified: true },
  'Talen Energy':                          { searchTerm: 'Talen Energy',                    verified: true },
  'Idaho National Laboratory':             { searchTerm: 'Idaho National Laboratory',       verified: true },
  'INL':                                   { searchTerm: 'Idaho National Laboratory',       verified: true },
  'Nvidia':                                { searchTerm: 'NVIDIA',                          verified: true },
  'EDF':                                   { searchTerm: 'EDF',                             verified: true },
  'Nuclear Decommissioning Authority':     { searchTerm: 'Nuclear Decommissioning',         verified: true },
  'NDA':                                   { searchTerm: 'Nuclear Decommissioning',         verified: true },
  'Nuclear Restoration Services':          { searchTerm: 'Nuclear Restoration Services',   verified: true },
  'ONR':                                   { searchTerm: 'Office for Nuclear Regulation',   verified: true },
  'Makwa Development':                     { searchTerm: 'Makwa Development',               verified: true },
  'Kairos Power':                          { searchTerm: 'Kairos Power',                    verified: true },

  // From post content analysis — run npm run test-mentions to verify
  'Helion':                                { searchTerm: 'Helion - Future Energy',          verified: true },
  'NRC':                                   { searchTerm: 'Nuclear Regulatory Commission',   verified: true },
  'Nuclear Regulatory Commission':         { searchTerm: 'Nuclear Regulatory Commission',   verified: true },
  'OpenAI':                                { searchTerm: 'OpenAI',                          verified: true },
  'Google':                                { searchTerm: 'Google',                          verified: true },
  'TVA':                                   { searchTerm: 'Tennessee Valley Authority',       verified: true },
  'Tennessee Valley Authority':            { searchTerm: 'Tennessee Valley Authority',       verified: true },
  'Ontario Tech University':               { searchTerm: 'Ontario Tech University',          verified: true },
  'Ontario Tech':                          { searchTerm: 'Ontario Tech University',          verified: true },
  'Great British Energy':                  { searchTerm: 'Great British Energy',             verified: true },
  'Skills Ontario':                        { searchTerm: 'Skills Ontario',                   verified: true },

  // From RSS feed analysis — run npm run test-mentions to verify
  'Oklo':                                  { searchTerm: 'Oklo',                            verified: true },
  'NexGen Energy':                         { searchTerm: 'NexGen Energy',                   verified: true },
  'Denison Mines':                         { searchTerm: 'Denison Mines',                   verified: true },
  'Rolls-Royce SMR':                       { searchTerm: 'Rolls-Royce SMR',                 verified: true },
  'APS':                                   { searchTerm: 'Arizona Public Service',          verified: true },
  'Arizona Public Service':                { searchTerm: 'Arizona Public Service',          verified: true },
  'Burns & McDonnell':                     { searchTerm: 'Burns McDonnell',                 verified: true },
  'Amentum':                               { searchTerm: 'Amentum',                         verified: true },
  'Deep Fission':                          { searchTerm: 'Deep Fission',                    verified: true },
  'Aalo Atomics':                          { searchTerm: 'Aalo Atomics',                    verified: true },
  'General Matter':                        { searchTerm: 'General Matter',                  verified: true },
  'Kinectrics':                            { searchTerm: 'Kinectrics',                      verified: true },
  'Holtec International':                  { searchTerm: 'Holtec International',            verified: true },
  'IAEA':                                  { searchTerm: 'International Atomic Energy',     verified: true },
  'ANS':                                   { searchTerm: 'American Nuclear Society',        verified: true },
  // Auto-detected — run npm run test-mentions to verify
  'Framatome':                                 { searchTerm: 'Framatome',                  verified: true },
  'SCK CEN':                                   { searchTerm: 'SCK CEN',                    verified: true },
  'Nuclearelectrica':                          { searchTerm: 'Nuclearelectrica',           verified: true },
  'Cernavodă Nuclear Power Plant':             { searchTerm: 'Cernavodă Nuclear Power Plant', verified: true },
  'S&P Global':                                { searchTerm: 'S&P Global',                 verified: true },
  'Fermi America':                             { searchTerm: 'Fermi America',              verified: true },
  'GE Vernova Hitachi':                        { searchTerm: 'GE Vernova Hitachi',         verified: true },
  'Global Laser Enrichment':                   { searchTerm: 'Global Laser Enrichment',    verified: true },
  'UNC Charlotte':                             { searchTerm: 'UNC Charlotte',              verified: true },
  'GE Vernova':                                { searchTerm: 'GE Vernova',                 verified: true },

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify
  'Nordion':                                   { searchTerm: 'Nordion Energi',                    verified: true },

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify
  'Blue Ribbon Commission':                    { searchTerm: 'Blue Ribbon Commission',     verified: true },
  'Idaho National Lab':                        { searchTerm: 'Idaho National Lab',         verified: true },

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify
  'TerraFlow Energy':                          { searchTerm: 'TerraFlow Energy',           verified: true },

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify
  'Everstar':                                  { searchTerm: 'Everstar',                   verified: false },

  // Auto-detected — run npm run test-mentions to verify
  'Nano Nuclear':                              { searchTerm: 'Nano Nuclear Power PLC',               verified: true },

  // Auto-detected — run npm run test-mentions to verify
  'Meta':                                      { searchTerm: 'Meta',                       verified: false },
  'YouTube':                                   { searchTerm: 'YouTube',                    verified: true },

  // Auto-detected — run npm run test-mentions to verify
  'Department of Atomic Energy':               { searchTerm: 'Department of Atomic Energy', verified: true },

  // Auto-detected — run npm run test-mentions to verify
  'Diablo Canyon':                             { searchTerm: 'Diablo Canyon',              verified: true },

  // Auto-detected — run npm run test-mentions to verify

  // Auto-detected — run npm run test-mentions to verify
  'European Union':                            { searchTerm: 'European Union',             verified: true },

  // Auto-detected — run npm run test-mentions to verify
  'DOE':                                       { searchTerm: 'DOE',                        verified: false },

  // Auto-detected — run npm run test-mentions to verify
  'DOE':                                       { searchTerm: 'DOE',                        verified: false },

};

// Returns only verified entries — used during posting
export function verifiedMentions(): Record<string, MentionEntry> {
  return Object.fromEntries(
    Object.entries(MENTIONS).filter(([, entry]) => entry.verified)
  );
}

// Appends newly discovered company names as unverified entries.
// Skips names already present in the dictionary (case-insensitive).
// Called automatically after each post is generated.
export function addUnverifiedMentions(names: string[]): void {
  const existingKeys = new Set(Object.keys(MENTIONS).map(k => k.toLowerCase()));
  const blocked = loadBlocklist();
  const toAdd = names.filter(n => n.length > 2 && !existingKeys.has(n.toLowerCase()) && !blocked.has(n.toLowerCase()));
  if (toAdd.length === 0) return;

  let src = readFileSync(MENTIONS_FILE, 'utf8').replace(/\r\n/g, '\n');
  const insertPoint = src.lastIndexOf('\n};\n');
  if (insertPoint === -1) { console.warn('mentions.ts: could not find insertion point'); return; }

  // Ensure the last real entry before }; has a trailing comma
  const before = src.slice(0, insertPoint);
  const lastBrace = before.lastIndexOf('}');
  if (lastBrace !== -1 && before.slice(lastBrace + 1).trim() === '') {
    src = src.slice(0, lastBrace + 1) + ',' + src.slice(lastBrace + 1);
  }

  let newLines = '\n  // Auto-detected — run npm run test-mentions to verify\n';
  for (const name of toAdd) {
    const safe = name.replace(/'/g, "\\'");
    const pad = Math.max(1, 42 - safe.length);
    newLines += `  '${safe}':${' '.repeat(pad)}{ searchTerm: '${safe}',${' '.repeat(Math.max(1, 27 - safe.length))}verified: false },\n`;
  }

  src = src.slice(0, insertPoint) + newLines + src.slice(insertPoint);
  writeFileSync(MENTIONS_FILE, src, 'utf8');
  console.log(`Mentions: added ${toAdd.length} unverified — ${toAdd.join(', ')}`);
}

// Removes an entry from the dictionary source file entirely.
// Used by test-mentions when a search term doesn't resolve correctly.
export function removeMentionEntry(name: string): void {
  const src = readFileSync(MENTIONS_FILE, 'utf8');
  const lines = src.split(/\r?\n/);
  // Match the line that starts this entry, e.g.:  'Arup':  { ... }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp(`^\\s*'${escaped}'\\s*:`);
  const idx = lines.findIndex(l => lineRe.test(l));
  if (idx === -1) { console.warn(`  Could not find entry for "${name}" to remove.`); return; }
  lines.splice(idx, 1);
  writeFileSync(MENTIONS_FILE, lines.join('\n'), 'utf8');
  addToBlocklist(name);
  console.log(`  Removed "${name}" from mentions and added to blocklist.`);
}
