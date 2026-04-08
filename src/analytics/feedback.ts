// Confidence-weighted feedback loop logic.
// Replaces the naive average-based scoring in pipeline.ts and synthesize.ts.

import { confidenceWeightedScore, robustAverage, correlate, type Confidence, type ConfidenceScore } from './stats.js';
import { loadPostsWithMetrics, type PostAnalyticsRecord } from './post-data.js';

export interface TagScore {
  tag: string;
  score: number;
  confidence: Confidence;
  n: number;
}

export interface HashtagScore {
  hashtag: string;
  score: number;
  confidence: Confidence;
  n: number;
}

export interface CorrelationInsight {
  attribute: string;
  r: number;
  direction: string;
  significant: boolean;
}

/**
 * Returns confidence-weighted tag scores and a multiplier function.
 * Tags with low confidence (n < 3) get no boost.
 * Tags with medium confidence (n < 6) get dampened boost.
 * Tags with high confidence (n >= 6) get full multiplier range.
 */
export function getConfidenceWeightedTagScores(): {
  tagScores: TagScore[];
  computeMultiplier: (tags: string[]) => number;
} {
  const posts = loadPostsWithMetrics();
  const tagValues: Record<string, number[]> = {};

  for (const p of posts) {
    for (const tag of p.contentTags) {
      if (!tagValues[tag]) tagValues[tag] = [];
      tagValues[tag].push(p.compositeScore);
    }
  }

  // Only tags with 2+ posts
  const tagScores: TagScore[] = Object.entries(tagValues)
    .filter(([, v]) => v.length >= 2)
    .map(([tag, values]) => {
      const cws = confidenceWeightedScore(values);
      return { tag, score: cws.score, confidence: cws.confidence, n: cws.n };
    })
    .sort((a, b) => b.score - a.score);

  // Global median for comparison
  const allScores = tagScores.map(t => t.score);
  const globalMedian = allScores.length > 0 ? robustAverage(allScores) : 1;

  const tagMap = new Map(tagScores.map(t => [t.tag, t]));

  function computeMultiplier(tags: string[]): number {
    if (tagScores.length === 0 || tags.length === 0) return 1.0;

    const matched = tags.map(t => tagMap.get(t)).filter((t): t is TagScore => t != null);
    if (matched.length === 0) return 1.0;

    const avgScore = robustAverage(matched.map(t => t.score));
    const rawMultiplier = globalMedian > 0 ? avgScore / globalMedian : 1.0;

    // Confidence dampening: blend toward 1.0 for low-confidence data
    const avgConfidence = matched.reduce((sum, t) => {
      const damper = t.confidence === 'high' ? 1.0 : t.confidence === 'medium' ? 0.5 : 0.0;
      return sum + damper;
    }, 0) / matched.length;

    const multiplier = 1.0 + (rawMultiplier - 1.0) * avgConfidence;
    return Math.min(1.25, Math.max(1.0, multiplier));
  }

  return { tagScores, computeMultiplier };
}

/**
 * Returns confidence-weighted hashtag performance for synthesis prompt guidance.
 */
export function getConfidenceWeightedHashtagPerformance(): HashtagScore[] {
  const posts = loadPostsWithMetrics();
  const hashValues: Record<string, number[]> = {};

  for (const p of posts) {
    for (const ht of p.hashtags) {
      if (!hashValues[ht]) hashValues[ht] = [];
      hashValues[ht].push(p.compositeScore);
    }
  }

  return Object.entries(hashValues)
    .filter(([, v]) => v.length >= 2)
    .map(([hashtag, values]) => {
      const cws = confidenceWeightedScore(values);
      return { hashtag, score: cws.score, confidence: cws.confidence, n: cws.n };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Correlates composite score with various post attributes.
 * Returns insights sorted by |r|, strongest correlation first.
 */
export function getCorrelationInsights(): CorrelationInsight[] {
  const posts = loadPostsWithMetrics();
  if (posts.length < 5) return [];

  const scores = posts.map(p => p.compositeScore);

  const attributes: Array<{ name: string; values: number[] }> = [
    { name: 'Word count', values: posts.map(p => p.wordCount) },
    { name: 'Cringe score', values: posts.map(p => p.cringeScore) },
    { name: 'Hour of day (ET)', values: posts.map(p => p.hourET) },
    { name: 'Days since first post', values: posts.map(p => p.dayIndex) },
  ];

  return attributes
    .map(attr => {
      const result = correlate(attr.values, scores);
      const direction = result.r > 0.1 ? 'positive' : result.r < -0.1 ? 'negative' : 'none';
      return { attribute: attr.name, r: result.r, direction, significant: result.significant };
    })
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}
