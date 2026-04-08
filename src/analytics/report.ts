// Enhanced weekly report generation using statistical analysis.

import {
  groupStats, trendLine, detectOutliers, bucketCompare,
  robustAverage, confidenceWeightedScore,
  type GroupStats, type TrendResult,
} from './stats.js';
import { loadPostsWithMetrics, type PostAnalyticsRecord } from './post-data.js';
import { getCorrelationInsights, type CorrelationInsight } from './feedback.js';

export interface RankEntry {
  label: string;
  avg: number;
  count: number;
  confidence: string;
}

export interface ReportData {
  postCount: number;
  dateRange: { start: string; end: string };
  // Aggregates
  totalImpressions: number;
  totalReactions: number;
  totalComments: number;
  totalReposts: number;
  totalSaves: number;
  totalNewFollowers: number;
  avgImpressions: number;
  overallEngRate: string;
  avgWordCount: number | null;
  // Statistical summary
  scoreStats: GroupStats;
  // Trend
  trend: TrendResult;
  // Correlations
  correlations: CorrelationInsight[];
  // Rankings
  typeRanking: RankEntry[];
  tagRanking: RankEntry[];
  hashtagRanking: RankEntry[];
  feedRanking: RankEntry[];
  dayRanking: RankEntry[];
  windowRanking: RankEntry[];
  // Comparisons
  photoComparison: { withPhoto: GroupStats | null; noPhoto: GroupStats | null } | null;
  wordCountBuckets: Record<string, { stats: GroupStats; significant: boolean }> | null;
  // Outliers
  outliers: Array<{ snippet: string; score: number; sigma: number }>;
  // Best post
  bestPost: { snippet: string; postType: string; score: number; impressions: number } | null;
}

function rankBy(posts: PostAnalyticsRecord[], extract: (p: PostAnalyticsRecord) => string | string[]): RankEntry[] {
  const map = new Map<string, number[]>();
  for (const p of posts) {
    const vals = extract(p);
    for (const v of (Array.isArray(vals) ? vals : [vals])) {
      if (!map.has(v)) map.set(v, []);
      map.get(v)!.push(p.compositeScore);
    }
  }
  return [...map.entries()]
    .map(([label, values]) => {
      const cws = confidenceWeightedScore(values);
      return { label, avg: cws.score, count: cws.n, confidence: cws.confidence };
    })
    .sort((a, b) => b.avg - a.avg);
}

export function generateReportData(maxAgeDays = 30): ReportData {
  const posts = loadPostsWithMetrics(maxAgeDays);
  const scores = posts.map(p => p.compositeScore);

  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  const dateRange = {
    start: cutoff.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }),
    end: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }),
  };

  // Aggregates
  const totalImpressions = posts.reduce((s, p) => s + p.impressions, 0);
  const totalReactions = posts.reduce((s, p) => s + p.reactions, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalReposts = posts.reduce((s, p) => s + p.reposts, 0);
  const totalSaves = posts.reduce((s, p) => s + p.saves, 0);
  const totalNewFollowers = posts.reduce((s, p) => s + p.newFollowers, 0);
  const totalEng = totalReactions + totalComments + totalReposts;
  const avgImpressions = posts.length > 0 ? Math.round(totalImpressions / posts.length) : 0;
  const overallEngRate = totalImpressions > 0 ? ((totalEng / totalImpressions) * 100).toFixed(1) : 'n/a';

  // Word counts
  const wordCounts = posts.map(p => p.wordCount).filter(n => n > 0);
  const avgWordCount = wordCounts.length > 0 ? Math.round(robustAverage(wordCounts)) : null;

  // Statistical summary
  const scoreStats = groupStats(scores);

  // Trend over time
  const trend = trendLine(posts.map(p => ({ x: p.dayIndex, y: p.compositeScore })));

  // Correlations
  const correlations = getCorrelationInsights();

  // Rankings
  const typeRanking = rankBy(posts, p => p.postType);
  const tagRanking = rankBy(posts, p => p.contentTags).slice(0, 5);
  const hashtagRanking = rankBy(posts, p => p.hashtags).slice(0, 5);
  const feedRanking = rankBy(posts, p => p.sourceFeed);
  const dayRanking = rankBy(posts, p => p.dayOfWeek);
  const windowRanking = rankBy(posts, p => p.timeWindow);

  // Photo comparison
  const withPhotoScores = posts.filter(p => p.imageChoice !== 'none').map(p => p.compositeScore);
  const noPhotoScores = posts.filter(p => p.imageChoice === 'none').map(p => p.compositeScore);
  const photoComparison = (withPhotoScores.length > 0 || noPhotoScores.length > 0)
    ? {
        withPhoto: withPhotoScores.length > 0 ? groupStats(withPhotoScores) : null,
        noPhoto: noPhotoScores.length > 0 ? groupStats(noPhotoScores) : null,
      }
    : null;

  // Word count buckets
  const wcBuckets: Record<string, number[]> = { 'Short (<120)': [], 'Medium (120-170)': [], 'Long (>170)': [] };
  for (const p of posts) {
    if (p.wordCount < 120) wcBuckets['Short (<120)'].push(p.compositeScore);
    else if (p.wordCount <= 170) wcBuckets['Medium (120-170)'].push(p.compositeScore);
    else wcBuckets['Long (>170)'].push(p.compositeScore);
  }
  const hasWcData = Object.values(wcBuckets).some(v => v.length > 0);
  const wordCountBuckets = hasWcData ? bucketCompare(wcBuckets) : null;

  // Outliers
  const outlierResult = detectOutliers(scores);
  const outliers = outlierResult.outlierIndices.map(i => {
    const p = posts[i];
    const mean = scoreStats.mean;
    const sd = scoreStats.stddev;
    const sigma = sd > 0 ? (p.compositeScore - mean) / sd : 0;
    return { snippet: p.postSnippet, score: p.compositeScore, sigma };
  });

  // Best post
  const bestIdx = scores.indexOf(Math.max(...scores));
  const bestPost = posts.length > 0
    ? {
        snippet: posts[bestIdx].postSnippet,
        postType: posts[bestIdx].postType,
        score: posts[bestIdx].compositeScore,
        impressions: posts[bestIdx].impressions,
      }
    : null;

  return {
    postCount: posts.length, dateRange,
    totalImpressions, totalReactions, totalComments, totalReposts,
    totalSaves, totalNewFollowers, avgImpressions, overallEngRate,
    avgWordCount, scoreStats, trend, correlations,
    typeRanking, tagRanking, hashtagRanking, feedRanking,
    dayRanking, windowRanking,
    photoComparison, wordCountBuckets, outliers, bestPost,
  };
}

export function formatReportMessage(d: ReportData): string {
  const fmt = (n: number) => n.toFixed(1);
  const medals = ['🥇', '🥈', '🥉'];

  const rankLine = (r: RankEntry, i: number) => {
    const medal = medals[i] ?? '  •';
    const conf = r.confidence === 'low' ? ' ⚠️' : '';
    return `${medal} \`${r.label}\` — ${fmt(r.avg)} score (${r.count} post${r.count !== 1 ? 's' : ''})${conf}`;
  };

  // Trend emoji
  const trendEmoji = d.trend.direction === 'improving' ? '📈' : d.trend.direction === 'declining' ? '📉' : '➡️';
  const trendStr = d.trend.direction === 'flat'
    ? `${trendEmoji} Flat`
    : `${trendEmoji} ${d.trend.direction.charAt(0).toUpperCase() + d.trend.direction.slice(1)} — ${d.trend.slope > 0 ? '+' : ''}${fmt(d.trend.slope * 7)} score/week (R²=${fmt(d.trend.rSquared)})`;

  // Correlations
  const corrLines = d.correlations
    .filter(c => Math.abs(c.r) > 0.2)
    .map(c => {
      const dir = c.r > 0 ? 'higher → better' : 'lower → better';
      const sig = c.significant ? '' : ' (not significant)';
      return `• ${c.attribute}: r=${fmt(c.r)} (${dir})${sig}`;
    })
    .join('\n');

  // Word count buckets
  let wcSection = '';
  if (d.wordCountBuckets) {
    const lines = Object.entries(d.wordCountBuckets)
      .filter(([, v]) => v.stats.n > 0)
      .map(([label, v]) => {
        const conf = v.stats.n < 3 ? ' ⚠️ low confidence' : '';
        return `• ${label}: median ${fmt(v.stats.median)} score (${v.stats.n} posts)${conf}`;
      })
      .join('\n');
    if (lines) wcSection = `\n*Word count buckets:*\n${lines}`;
  }

  // Outliers
  const outlierLines = d.outliers
    .map(o => `${o.sigma > 0 ? '🚀' : '📉'} ${o.snippet}… — score ${fmt(o.score)} (${fmt(Math.abs(o.sigma))}σ ${o.sigma > 0 ? 'above' : 'below'} mean)`)
    .join('\n');

  // Photo comparison
  let photoLine = '';
  if (d.photoComparison) {
    const parts = [];
    if (d.photoComparison.withPhoto) parts.push(`📷 with photo (${d.photoComparison.withPhoto.n}): median ${fmt(d.photoComparison.withPhoto.median)} score`);
    if (d.photoComparison.noPhoto) parts.push(`🚫 no photo (${d.photoComparison.noPhoto.n}): median ${fmt(d.photoComparison.noPhoto.median)} score`);
    if (parts.length > 0) photoLine = `\n*Photo vs no photo:*\n${parts.join(' | ')}`;
  }

  return `📊 *Monthly Report* (${d.dateRange.start}–${d.dateRange.end})

*Posts published:* ${d.postCount}
*Impressions:* ${d.totalImpressions.toLocaleString()} (avg ${d.avgImpressions.toLocaleString()}/post)
*Engagement rate:* ${d.overallEngRate}%
*Reactions:* ${d.totalReactions} | *Comments:* ${d.totalComments} | *Reposts:* ${d.totalReposts}
*Saves:* ${d.totalSaves} | *New followers:* ${d.totalNewFollowers}
*Score:* median ${fmt(d.scoreStats.median)}, mean ${fmt(d.scoreStats.mean)}, stddev ${fmt(d.scoreStats.stddev)}
*IQR:* ${fmt(d.scoreStats.p25)}–${fmt(d.scoreStats.p75)} | *Range:* ${fmt(d.scoreStats.min)}–${fmt(d.scoreStats.max)}${d.avgWordCount ? ` | *Avg words:* ${d.avgWordCount}` : ''}

*Performance trend:*
${trendStr}
${corrLines ? `\n*What correlates with performance:*\n${corrLines}` : ''}
*Post types:*
${d.typeRanking.map(rankLine).join('\n')}

*Top content tags:*
${d.tagRanking.length > 0 ? d.tagRanking.map(rankLine).join('\n') : '  _(no tags)_'}

*Top hashtags:*
${d.hashtagRanking.length > 0 ? d.hashtagRanking.map(rankLine).join('\n') : '  _(no hashtags)_'}

*By source feed:*
${d.feedRanking.map(rankLine).join('\n')}

*By day of week:*
${d.dayRanking.map(rankLine).join('\n')}

*By time window (ET):*
${d.windowRanking.map(rankLine).join('\n')}
${photoLine}${wcSection}${outlierLines ? `\n\n*Outliers:*\n${outlierLines}` : ''}

*Best post:* [${d.bestPost?.postType}] ${d.bestPost?.snippet}…
_Score: ${d.bestPost ? fmt(d.bestPost.score) : 'n/a'}${d.bestPost?.impressions ? ` · ${d.bestPost.impressions.toLocaleString()} impressions` : ''}_`;
}
