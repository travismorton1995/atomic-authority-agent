// Keyword bank for scoring outbound post relevance to the AI + Nuclear niche.
// Each keyword is lowercase. Multi-word phrases are matched as substrings.
// Returns the count of distinct keyword hits in the post text.

const KEYWORDS: string[] = [
  // --- Nuclear industry ---
  'nuclear', 'reactor', 'fission', 'fusion', 'uranium', 'plutonium', 'thorium',
  'smr', 'small modular reactor', 'candu', 'pressurized water reactor', 'pwr',
  'boiling water reactor', 'bwr', 'molten salt', 'sodium-cooled', 'fast reactor',
  'microreactor', 'isotope', 'cobalt-60', 'tritium', 'deuterium',
  'fuel cycle', 'enrichment', 'spent fuel', 'waste storage', 'decommissioning',
  'new build', 'new-build', 'refurbishment', 'uprate', 'life extension',
  // --- Nuclear orgs & regulation ---
  'cnsc', 'nrc', 'iaea', 'doe', 'ferc', 'opg', 'bruce power', 'cnl',
  'neb', 'ans ', 'wano', 'inpo', 'epri',
  'regulatory', 'regulator', 'licensing', 'license application',
  'safety case', 'safety analysis', 'probabilistic risk', 'deterministic',
  'defense in depth', 'defence in depth', 'alara',
  // --- AI & machine learning ---
  'artificial intelligence', ' ai ', 'machine learning', 'deep learning',
  'neural network', 'large language model', 'llm', 'generative ai', 'gen ai',
  'natural language processing', 'nlp', 'computer vision',
  'reinforcement learning', 'transformer model',
  'chatgpt', 'openai', 'anthropic', 'claude', 'gemini', 'copilot',
  'diffusion model', 'foundation model', 'fine-tuning', 'fine tuning',
  'prompt engineering', 'rag', 'retrieval augmented', 'vector database',
  'ai safety', 'ai alignment', 'ai governance', 'ai regulation', 'ai risk',
  'autonomous system', 'agentic', 'ai agent',
  // --- AI applications in industry ---
  'digital twin', 'anomaly detection', 'predictive maintenance',
  'document automation', 'compliance automation', 'change management',
  'process automation', 'robotic process', 'intelligent automation',
  'computer-aided', 'simulation', 'modeling and simulation',
  'explainability', 'explainable ai', 'xai',
  // --- Energy & infrastructure ---
  'energy transition', 'clean energy', 'decarbonization', 'net zero', 'net-zero',
  'grid reliability', 'baseload', 'load following', 'capacity factor',
  'energy security', 'energy policy', 'electricity demand',
  'critical infrastructure', 'power grid', 'power plant',
  'datacenter', 'data center', 'hyperscaler',
  // --- Regulation & compliance (general) ---
  'cybersecurity', 'cyber security', 'supply chain security',
  'risk assessment', 'risk management', 'safety culture',
  'workforce development', 'knowledge management',
  'public opinion', 'social license', 'stakeholder engagement',
  // --- Adjacent tech ---
  'cloud computing', 'edge computing', 'iot ', 'scada', 'operational technology',
  'digital transformation', 'industry 4.0',
];

/**
 * Count how many distinct keywords appear in the post text.
 * Returns a number >= 0. Higher = more relevant.
 */
export function relevanceHits(postText: string): number {
  // Pad with spaces so word-boundary keywords like ' ai ' match at start/end
  const text = ` ${postText.toLowerCase()} `;
  let hits = 0;
  for (const kw of KEYWORDS) {
    if (text.includes(kw)) hits++;
  }
  return hits;
}
