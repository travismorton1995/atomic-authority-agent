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
  'New Brunswick Power':                   { searchTerm: 'NB Power',                        verified: false },
  'Canadian Nuclear Association':          { searchTerm: 'Canadian Nuclear Association',    verified: true },
  'CNA':                                   { searchTerm: 'Canadian Nuclear Association',    verified: true },
  'Talen Energy':                          { searchTerm: 'Talen Energy',                    verified: false },
  'Idaho National Laboratory':             { searchTerm: 'Idaho National Laboratory',       verified: false },
  'INL':                                   { searchTerm: 'Idaho National Laboratory',       verified: false },
  'Nvidia':                                { searchTerm: 'NVIDIA',                          verified: false },
  'EDF':                                   { searchTerm: 'EDF',                             verified: false },
  'Nuclear Decommissioning Authority':     { searchTerm: 'Nuclear Decommissioning',         verified: false },
  'NDA':                                   { searchTerm: 'Nuclear Decommissioning',         verified: false },
  'Nuclear Restoration Services':          { searchTerm: 'Nuclear Restoration Services',   verified: false },
  'ONR':                                   { searchTerm: 'Office for Nuclear Regulation',   verified: false },
  'Makwa Development':                     { searchTerm: 'Makwa Development',               verified: false },
  'Kairos Power':                          { searchTerm: 'Kairos Power',                    verified: false },
};

// Returns only verified entries — used during posting
export function verifiedMentions(): Record<string, MentionEntry> {
  return Object.fromEntries(
    Object.entries(MENTIONS).filter(([, entry]) => entry.verified)
  );
}
