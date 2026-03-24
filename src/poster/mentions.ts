// Company/org mention dictionary for LinkedIn @mentions.
// Each entry maps a canonical display name (as it might appear in post text)
// to the search term to type after `@` that reliably surfaces the correct
// LinkedIn autocomplete result as the first option.
//
// `verified` is set to true only after manually confirming via `npm run test-mentions`.
// Unverified entries are ignored during posting.

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

  // From RSS feed analysis — run npm run test-mentions to verify
  'Oklo':                                  { searchTerm: 'Oklo',                            verified: false },
  'NexGen Energy':                         { searchTerm: 'NexGen Energy',                   verified: false },
  'Denison Mines':                         { searchTerm: 'Denison Mines',                   verified: false },
  'Arup':                                  { searchTerm: 'Arup',                            verified: false },
  'Rolls-Royce SMR':                       { searchTerm: 'Rolls-Royce SMR',                 verified: false },
  'APS':                                   { searchTerm: 'Arizona Public Service',          verified: false },
  'Arizona Public Service':                { searchTerm: 'Arizona Public Service',          verified: false },
  'Burns & McDonnell':                     { searchTerm: 'Burns McDonnell',                 verified: false },
  'Amentum':                               { searchTerm: 'Amentum',                         verified: false },
  'Deep Fission':                          { searchTerm: 'Deep Fission',                    verified: false },
  'Aalo Atomics':                          { searchTerm: 'Aalo Atomics',                    verified: false },
  'General Matter':                        { searchTerm: 'General Matter',                  verified: false },
  'Kinectrics':                            { searchTerm: 'Kinectrics',                      verified: false },
  'Holtec International':                  { searchTerm: 'Holtec International',            verified: false },
  'IAEA':                                  { searchTerm: 'International Atomic Energy',     verified: false },
  'ANS':                                   { searchTerm: 'American Nuclear Society',        verified: false },
};

// Returns only verified entries — used during posting
export function verifiedMentions(): Record<string, MentionEntry> {
  return Object.fromEntries(
    Object.entries(MENTIONS).filter(([, entry]) => entry.verified)
  );
}
