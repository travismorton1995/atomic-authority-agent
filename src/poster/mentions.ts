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
  'Aalo Atomics':                              { searchTerm: 'Aalo Atomics',               verified: true },
  'Amazon':                                    { searchTerm: 'Amazon',                     verified: true },
  'Amentum':                                   { searchTerm: 'Amentum',                    verified: true },
  'AMPERA':                                    { searchTerm: 'AMPERA',                     verified: true },
  'ANS':                                       { searchTerm: 'American Nuclear Society',   verified: true },
  'ANSYS':                                     { searchTerm: 'ANSYS',                      verified: true },
  'APS':                                       { searchTerm: 'Arizona Public Service',     verified: true },
  'Arizona Public Service':                    { searchTerm: 'Arizona Public Service',     verified: true },
  'AtkinsRéalis':                              { searchTerm: 'AtkinsRéalis',               verified: true },
  'Atomic Canyon':                             { searchTerm: 'Atomic Canyon',              verified: true },
  'Blue Ribbon Commission':                    { searchTerm: 'Blue Ribbon Commission',     verified: true },
  'Bruce Power':                               { searchTerm: 'Bruce Power',                verified: true },
  'Burns & McDonnell':                         { searchTerm: 'Burns McDonnell',            verified: true },
  'BWXT':                                      { searchTerm: 'BWXT',                       verified: true },
  'Cameco':                                    { searchTerm: 'Cameco',                     verified: true },
  'Canadian Nuclear Association':              { searchTerm: 'Canadian Nuclear Association', verified: true },
  'Canadian Nuclear Laboratories':             { searchTerm: 'Canadian Nuclear Laboratories', verified: true },
  'Canadian Nuclear Safety Commission':        { searchTerm: 'Canadian Nuclear Safety',    verified: true },
  'Centrus Energy':                            { searchTerm: 'Centrus Energy',             verified: true },
  'Cernavodă Nuclear Power Plant':             { searchTerm: 'Cernavodă Nuclear Power Plant', verified: true },
  'CNA':                                       { searchTerm: 'Canadian Nuclear Association', verified: true },
  'CNL':                                       { searchTerm: 'Canadian Nuclear Laboratories', verified: true },
  'CNSC':                                      { searchTerm: 'Canadian Nuclear Safety',    verified: true },
  'Deep Fission':                              { searchTerm: 'Deep Fission',               verified: true },
  'Denison Mines':                             { searchTerm: 'Denison Mines',              verified: true },
  'Department of Atomic Energy':               { searchTerm: 'Department of Atomic Energy', verified: true },
  'Diablo Canyon':                             { searchTerm: 'Diablo Canyon',              verified: true },
  'DOE':                                       { searchTerm: 'U.S. Department of Energy ', verified: true },
  'Duke Energy':                               { searchTerm: 'Duke Energy',                verified: true },
  'EDF':                                       { searchTerm: 'EDF',                        verified: true },
  'EPRI':                                      { searchTerm: 'EPRI',                       verified: true },
  'European Union':                            { searchTerm: 'European Union',             verified: true },
  'Everstar':                                  { searchTerm: 'Everstar Inc.',              verified: true },
  'Fermi America':                             { searchTerm: 'Fermi America',              verified: true },
  'Fitch Solutions':                           { searchTerm: 'Fitch Solutions',            verified: true },
  'Framatome':                                 { searchTerm: 'Framatome',                  verified: true },
  'Gateway for Accelerated Innovation in Nuclear': { searchTerm: 'Gateway for Accelerated Innovation in Nuclear', verified: true },
  'GE Vernova':                                { searchTerm: 'GE Vernova',                 verified: true },
  'GE Vernova Hitachi':                        { searchTerm: 'GE Vernova Hitachi',         verified: true },
  'General Matter':                            { searchTerm: 'General Matter',             verified: true },
  'Global First Power':                        { searchTerm: 'Global First Power',         verified: true },
  'Global Laser Enrichment':                   { searchTerm: 'Global Laser Enrichment',    verified: true },
  'Google':                                    { searchTerm: 'Google',                     verified: true },
  'Great British Energy':                      { searchTerm: 'Great British Energy',       verified: true },
  'HALEU':                                     { searchTerm: 'HALEU',                      verified: true },
  'Helion':                                    { searchTerm: 'Helion - Future Energy',     verified: true },
  'Holtec International':                      { searchTerm: 'Holtec International',       verified: true },
  'IAEA':                                      { searchTerm: 'International Atomic Energy', verified: true },
  'Idaho National Lab':                        { searchTerm: 'Idaho National Lab',         verified: true },
  'Idaho National Laboratory':                 { searchTerm: 'Idaho National Laboratory',  verified: true },
  'Impact Assessment Agency':                  { searchTerm: 'Impact Assessment Agency',   verified: true },
  'INL':                                       { searchTerm: 'Idaho National Laboratory',  verified: true },
  'Kairos Power':                              { searchTerm: 'Kairos Power',               verified: true },
  'KHNP':                                      { searchTerm: 'KHNP',                       verified: true },
  'Kinectrics':                                { searchTerm: 'Kinectrics',                 verified: true },
  'Makwa Development':                         { searchTerm: 'Makwa Development',          verified: true },
  'Nano Nuclear':                              { searchTerm: 'Nano Nuclear Power PLC',     verified: true },
  'NASA':                                      { searchTerm: 'NASA',                       verified: true },
  'NDA':                                       { searchTerm: 'Nuclear Decommissioning',    verified: true },
  'New Brunswick Power':                       { searchTerm: 'NB Power',                   verified: true },
  'NexGen Energy':                             { searchTerm: 'NexGen Energy',              verified: true },
  'Nordion':                                   { searchTerm: 'Nordion Energi',             verified: true },
  'NPX':                                       { searchTerm: 'Nuclear Promise X',          verified: true },
  'NRC':                                       { searchTerm: 'Nuclear Regulatory Commission', verified: true },
  'Nuclear Decommissioning Authority':         { searchTerm: 'Nuclear Decommissioning',    verified: true },
  'Nuclear Promise X':                         { searchTerm: 'Nuclear Promise X',          verified: true },
  'Nuclear Regulatory Commission':             { searchTerm: 'Nuclear Regulatory Commission', verified: true },
  'Nuclear Restoration Services':              { searchTerm: 'Nuclear Restoration Services', verified: true },
  'Nuclearelectrica':                          { searchTerm: 'Nuclearelectrica',           verified: true },
  'NuScale':                                   { searchTerm: 'NuScale Power',              verified: true },
  'Nvidia':                                    { searchTerm: 'NVIDIA',                     verified: true },
  'Oak Ridge National Lab':                    { searchTerm: 'Oak Ridge National Lab',     verified: true },
  'Oak Ridge National Laboratory':             { searchTerm: 'Oak Ridge National Laboratory', verified: true },
  'Oklo':                                      { searchTerm: 'Oklo',                       verified: true },
  'ONR':                                       { searchTerm: 'Office for Nuclear Regulation', verified: true },
  'Ontario Power Generation':                  { searchTerm: 'Ontario Power Generation',   verified: true },
  'Ontario Tech':                              { searchTerm: 'Ontario Tech University',    verified: true },
  'Ontario Tech University':                   { searchTerm: 'Ontario Tech University',    verified: true },
  'OpenAI':                                    { searchTerm: 'OpenAI',                     verified: true },
  'OPG':                                       { searchTerm: 'Ontario Power Generation',   verified: true },
  'Orano':                                     { searchTerm: 'Orano',                      verified: true },
  'PG&E':                                      { searchTerm: 'PG&E',                       verified: true },
  'Rolls-Royce SMR':                           { searchTerm: 'Rolls-Royce SMR',            verified: true },
  'S&P Global':                                { searchTerm: 'S&P Global',                 verified: true },
  'SaskPower':                                 { searchTerm: 'SaskPower',                  verified: true },
  'SCK CEN':                                   { searchTerm: 'SCK CEN',                    verified: true },
  'Scorpio Tankers':                           { searchTerm: 'Scorpio Tankers',            verified: true },
  'Skills Ontario':                            { searchTerm: 'Skills Ontario',             verified: true },
  'Talen Energy':                              { searchTerm: 'Talen Energy',               verified: true },
  'Tennessee Valley Authority':                { searchTerm: 'Tennessee Valley Authority', verified: true },
  'TerraFlow Energy':                          { searchTerm: 'TerraFlow Energy',           verified: true },
  'TerraPower':                                { searchTerm: 'TerraPower',                 verified: true },
  'TVA':                                       { searchTerm: 'Tennessee Valley Authority', verified: true },
  'UNC Charlotte':                             { searchTerm: 'UNC Charlotte',              verified: true },
  'University of Regina':                      { searchTerm: 'University of Regina',       verified: true },
  'University of Sheffield':                   { searchTerm: 'University of Sheffield',    verified: true },
  'Westinghouse':                              { searchTerm: 'Westinghouse Electric Company', verified: true },
  'X-energy':                                  { searchTerm: 'X-energy',                   verified: true },
  'YouTube':                                   { searchTerm: 'YouTube',                    verified: true },
  'ASME':                                      { searchTerm: 'ASME',                       verified: false },
  'BMI':                                       { searchTerm: 'BMI',                        verified: false },
  'KRONOS':                                    { searchTerm: 'KRONOS',                     verified: false },
  'NexGen':                                    { searchTerm: 'NexGen',                     verified: false },
  'SCALE':                                     { searchTerm: 'SCALE',                      verified: false },
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
// Rewrites the MENTIONS block in mentions.ts, sorted: verified first (alphabetical), then unverified (alphabetical).
// Strips any comment lines between entries. Deduplicates via the in-memory MENTIONS object.
export function rewriteMentionsFile(): void {
  let src = readFileSync(MENTIONS_FILE, 'utf8').replace(/\r\n/g, '\n');

  // Find the MENTIONS block boundaries
  const startMarker = 'export const MENTIONS: Record<string, MentionEntry> = {';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf('\n};\n', startIdx);
  if (startIdx === -1 || endIdx === -1) {
    console.warn('mentions.ts: could not find MENTIONS block boundaries');
    return;
  }

  // Build sorted entries from in-memory MENTIONS
  const entries = Object.entries(MENTIONS);
  const verified = entries.filter(([, v]) => v.verified).sort(([a], [b]) => a.localeCompare(b));
  const unverified = entries.filter(([, v]) => !v.verified).sort(([a], [b]) => a.localeCompare(b));
  const sorted = [...verified, ...unverified];

  let block = '';
  for (const [name, entry] of sorted) {
    const safe = name.replace(/'/g, "\\'");
    const searchSafe = entry.searchTerm.replace(/'/g, "\\'");
    const pad = Math.max(1, 42 - safe.length);
    const searchPad = Math.max(1, 27 - searchSafe.length);
    block += `  '${safe}':${' '.repeat(pad)}{ searchTerm: '${searchSafe}',${' '.repeat(searchPad)}verified: ${entry.verified} },\n`;
  }

  const newSrc = src.slice(0, startIdx + startMarker.length + 1) + block + src.slice(endIdx + 1);
  writeFileSync(MENTIONS_FILE, newSrc, 'utf8');
}

export function addUnverifiedMentions(names: string[]): void {
  const existingKeys = new Set(Object.keys(MENTIONS).map(k => k.toLowerCase()));
  const blocked = loadBlocklist();
  const toAdd = names.filter(n => n.length > 2 && !existingKeys.has(n.toLowerCase()) && !blocked.has(n.toLowerCase()));
  if (toAdd.length === 0) return;

  // Add to in-memory MENTIONS
  for (const name of toAdd) {
    MENTIONS[name] = { searchTerm: name, verified: false };
  }

  // Rewrite the file sorted: verified first, then unverified
  rewriteMentionsFile();
  console.log(`Mentions: added ${toAdd.length} unverified — ${toAdd.join(', ')}`);
}

// Removes an entry from the dictionary and rewrites the file.
// Used by test-mentions when a search term doesn't resolve correctly.
export function removeMentionEntry(name: string): void {
  if (!(name in MENTIONS)) {
    console.warn(`  Could not find entry for "${name}" to remove.`);
    return;
  }
  delete MENTIONS[name];
  rewriteMentionsFile();
  addToBlocklist(name);
  console.log(`  Removed "${name}" from mentions and added to blocklist.`);
}
