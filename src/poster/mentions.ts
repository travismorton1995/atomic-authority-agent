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
  'Bruce Power':                           { searchTerm: 'Bruce Power',                     verified: false },
  'Canadian Nuclear Safety Commission':    { searchTerm: 'Canadian Nuclear Safety',         verified: false },
  'CNSC':                                  { searchTerm: 'Canadian Nuclear Safety',         verified: false },
  'Canadian Nuclear Laboratories':         { searchTerm: 'Canadian Nuclear Laboratories',   verified: false },
  'CNL':                                   { searchTerm: 'Canadian Nuclear Laboratories',   verified: false },
  'Ontario Power Generation':              { searchTerm: 'Ontario Power Generation',        verified: false },
  'OPG':                                   { searchTerm: 'Ontario Power Generation',        verified: false },
  'Nuclear Promise X':                     { searchTerm: 'Nuclear Promise X',               verified: false },
  'NPX':                                   { searchTerm: 'Nuclear Promise X',               verified: false },
  'AtkinsRéalis':                          { searchTerm: 'AtkinsRéalis',                    verified: false },
  'Westinghouse':                          { searchTerm: 'Westinghouse Electric Company',   verified: false },
  'NuScale':                               { searchTerm: 'NuScale Power',                   verified: false },
  'TerraPower':                            { searchTerm: 'TerraPower',                      verified: false },
  'X-energy':                              { searchTerm: 'X-energy',                        verified: false },
  'Global First Power':                    { searchTerm: 'Global First Power',              verified: false },
  'New Brunswick Power':                   { searchTerm: 'NB Power',                        verified: false },
  'Canadian Nuclear Association':          { searchTerm: 'Canadian Nuclear Association',    verified: false },
  'CNA':                                   { searchTerm: 'Canadian Nuclear Association',    verified: false },
};

// Returns only verified entries — used during posting
export function verifiedMentions(): Record<string, MentionEntry> {
  return Object.fromEntries(
    Object.entries(MENTIONS).filter(([, entry]) => entry.verified)
  );
}
