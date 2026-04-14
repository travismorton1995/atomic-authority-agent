// Enhanced weekly report generation using statistical analysis.
// All-time data for rankings + recent trend comparison.

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
  // All-time
  postCount: number;
  firstPostDate: string;
  totalImpressions: number;
  totalReactions: number;
  totalComments: number;
  totalReposts: number;
  totalSaves: number;
  totalNewFollowers: number;
  avgImpressions: number;
  overallEngRate: string;
  avgWordCount: number | null;
  scoreStats: GroupStats;
  trend: TrendResult;
  correlations: CorrelationInsight[];
  // Rankings (all-time)
  typeRanking: RankEntry[];
  tagRanking: RankEntry[];
  hashtagRanking: RankEntry[];
  feedRanking: RankEntry[];
  dayRanking: RankEntry[];
  windowRanking: RankEntry[];
  photoComparison: { ogPhoto: GroupStats | null; aiPhoto: GroupStats | null; customPhoto: GroupStats | null; noPhoto: GroupStats | null } | null;
  wordCountBuckets: Record<string, { stats: GroupStats; significant: boolean }> | null;
  outliers: Array<{ snippet: string; score: number; sigma: number }>;
  bestPost: { snippet: string; postType: string; score: number; impressions: number } | null;
  // Recent period comparison
  recent: {
    postCount: number;
    periodDays: number;
    avgScore: number;
    avgImpressions: number;
    totalNewFollowers: number;
    engRate: string;
  } | null;
  allTimeAvgScore: number;
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

export function generateReportData(): ReportData {
  // All-time data for rankings and totals
  const posts = loadPostsWithMetrics();
  const scores = posts.map(p => p.compositeScore);

  if (posts.length === 0) {
    return emptyReport();
  }

  const firstPostDate = posts.reduce((min, p) => p.publishedAt < min ? p.publishedAt : min, posts[0].publishedAt)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });

  // Aggregates
  const totalImpressions = posts.reduce((s, p) => s + p.impressions, 0);
  const totalReactions = posts.reduce((s, p) => s + p.reactions, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalReposts = posts.reduce((s, p) => s + p.reposts, 0);
  const totalSaves = posts.reduce((s, p) => s + p.saves, 0);
  const totalNewFollowers = posts.reduce((s, p) => s + p.newFollowers, 0);
  const totalEng = totalReactions + totalComments + totalReposts;
  const avgImpressions = Math.round(totalImpressions / posts.length);
  const overallEngRate = totalImpressions > 0 ? ((totalEng / totalImpressions) * 100).toFixed(1) : 'n/a';

  const wordCounts = posts.map(p => p.wordCount).filter(n => n > 0);
  const avgWordCount = wordCounts.length > 0 ? Math.round(robustAverage(wordCounts)) : null;

  const scoreStats = groupStats(scores);
  const allTimeAvgScore = scoreStats.mean;
  const trend = trendLine(posts.map(p => ({ x: p.dayIndex, y: p.compositeScore })));
  const correlations = getCorrelationInsights();

  // Rankings (all-time)
  const typeRanking = rankBy(posts, p => p.postType);
  const tagRanking = rankBy(posts, p => p.contentTags).slice(0, 5);
  const hashtagRanking = rankBy(posts, p => p.hashtags).slice(0, 5);
  const feedRanking = rankBy(posts, p => p.sourceFeed);
  const dayRanking = rankBy(posts, p => p.dayOfWeek);
  const windowRanking = rankBy(posts, p => p.timeWindow);

  // Photo comparison — OG, AI-generated, custom, none
  const ogPhotoScores = posts.filter(p => p.imageChoice === 'og').map(p => p.compositeScore);
  const aiPhotoScores = posts.filter(p => p.imageChoice === 'ai').map(p => p.compositeScore);
  const customPhotoScores = posts.filter(p => p.imageChoice === 'custom').map(p => p.compositeScore);
  const noPhotoScores = posts.filter(p => p.imageChoice === 'none').map(p => p.compositeScore);
  const photoComparison = (ogPhotoScores.length > 0 || aiPhotoScores.length > 0 || customPhotoScores.length > 0 || noPhotoScores.length > 0)
    ? {
        ogPhoto: ogPhotoScores.length > 0 ? groupStats(ogPhotoScores) : null,
        aiPhoto: aiPhotoScores.length > 0 ? groupStats(aiPhotoScores) : null,
        customPhoto: customPhotoScores.length > 0 ? groupStats(customPhotoScores) : null,
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
    const sd = scoreStats.stddev;
    const sigma = sd > 0 ? (p.compositeScore - scoreStats.mean) / sd : 0;
    return { snippet: p.postSnippet, score: p.compositeScore, sigma };
  });

  // Best post
  const bestIdx = scores.indexOf(Math.max(...scores));
  const bestPost = {
    snippet: posts[bestIdx].postSnippet,
    postType: posts[bestIdx].postType,
    score: posts[bestIdx].compositeScore,
    impressions: posts[bestIdx].impressions,
  };

  // Recent period (last 14 days) for trend comparison
  const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentPosts = posts.filter(p => p.publishedAt.getTime() >= recentCutoff);
  let recent: ReportData['recent'] = null;
  if (recentPosts.length > 0) {
    const rImpressions = recentPosts.reduce((s, p) => s + p.impressions, 0);
    const rEng = recentPosts.reduce((s, p) => s + p.reactions + p.comments + p.reposts, 0);
    recent = {
      postCount: recentPosts.length,
      periodDays: 14,
      avgScore: robustAverage(recentPosts.map(p => p.compositeScore)),
      avgImpressions: Math.round(rImpressions / recentPosts.length),
      totalNewFollowers: recentPosts.reduce((s, p) => s + p.newFollowers, 0),
      engRate: rImpressions > 0 ? ((rEng / rImpressions) * 100).toFixed(1) : 'n/a',
    };
  }

  return {
    postCount: posts.length, firstPostDate,
    totalImpressions, totalReactions, totalComments, totalReposts,
    totalSaves, totalNewFollowers, avgImpressions, overallEngRate,
    avgWordCount, scoreStats, trend, correlations, allTimeAvgScore,
    typeRanking, tagRanking, hashtagRanking, feedRanking,
    dayRanking, windowRanking,
    photoComparison, wordCountBuckets, outliers, bestPost, recent,
  };
}

function emptyReport(): ReportData {
  const empty = groupStats([]);
  return {
    postCount: 0, firstPostDate: '',
    totalImpressions: 0, totalReactions: 0, totalComments: 0, totalReposts: 0,
    totalSaves: 0, totalNewFollowers: 0, avgImpressions: 0, overallEngRate: 'n/a',
    avgWordCount: null, scoreStats: empty, trend: { slope: 0, intercept: 0, rSquared: 0, predict: () => 0, direction: 'flat' },
    correlations: [], allTimeAvgScore: 0,
    typeRanking: [], tagRanking: [], hashtagRanking: [], feedRanking: [],
    dayRanking: [], windowRanking: [],
    photoComparison: null, wordCountBuckets: null, outliers: [], bestPost: null, recent: null,
  };
}

export function formatReportMessage(d: ReportData): string {
  if (d.postCount === 0) return '📊 No published posts with metrics yet.';

  const fmt = (n: number) => n.toFixed(1);
  const medals = ['🥇', '🥈', '🥉'];

  const rankLine = (r: RankEntry, i: number) => {
    const medal = medals[i] ?? '  •';
    const conf = r.confidence === 'low' ? ' ⚠️' : '';
    return `${medal} \`${r.label}\` — ${fmt(r.avg)} score (${r.count} post${r.count !== 1 ? 's' : ''})${conf}`;
  };

  // Trend
  const trendEmoji = d.trend.direction === 'improving' ? '📈' : d.trend.direction === 'declining' ? '📉' : '➡️';
  const trendStr = d.trend.direction === 'flat'
    ? `${trendEmoji} Flat`
    : `${trendEmoji} ${d.trend.direction.charAt(0).toUpperCase() + d.trend.direction.slice(1)} — ${d.trend.slope > 0 ? '+' : ''}${fmt(d.trend.slope * 7)} score/week (R²=${fmt(d.trend.rSquared)})`;

  // Recent comparison
  let recentSection = '';
  if (d.recent && d.recent.postCount > 0) {
    const scoreDelta = d.recent.avgScore - d.allTimeAvgScore;
    const deltaEmoji = scoreDelta > 5 ? '🔼' : scoreDelta < -5 ? '🔽' : '➡️';
    recentSection = `\n*Last ${d.recent.periodDays} days* (${d.recent.postCount} posts):
Avg score: ${fmt(d.recent.avgScore)} ${deltaEmoji} (all-time: ${fmt(d.allTimeAvgScore)})
Avg impressions: ${d.recent.avgImpressions.toLocaleString()}/post | Eng rate: ${d.recent.engRate}%
New followers: ${d.recent.totalNewFollowers}`;
  }

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

  // Photo comparison — OG, AI-generated, custom, none
  let photoLine = '';
  if (d.photoComparison) {
    const parts = [];
    if (d.photoComparison.ogPhoto) parts.push(`🖼️ OG photo (${d.photoComparison.ogPhoto.n}): median ${fmt(d.photoComparison.ogPhoto.median)} score`);
    if (d.photoComparison.aiPhoto) parts.push(`🤖 AI photo (${d.photoComparison.aiPhoto.n}): median ${fmt(d.photoComparison.aiPhoto.median)} score`);
    if (d.photoComparison.customPhoto) parts.push(`📷 Custom photo (${d.photoComparison.customPhoto.n}): median ${fmt(d.photoComparison.customPhoto.median)} score`);
    if (d.photoComparison.noPhoto) parts.push(`🚫 no image (${d.photoComparison.noPhoto.n}): median ${fmt(d.photoComparison.noPhoto.median)} score`);
    if (parts.length > 0) photoLine = `\n*Image breakdown:*\n${parts.join(' | ')}`;
  }

  return `📊 *Performance Report* — All-time (since ${d.firstPostDate})

*Posts published:* ${d.postCount}
*Impressions:* ${d.totalImpressions.toLocaleString()} (avg ${d.avgImpressions.toLocaleString()}/post)
*Engagement rate:* ${d.overallEngRate}%
*Reactions:* ${d.totalReactions} | *Comments:* ${d.totalComments} | *Reposts:* ${d.totalReposts}
*Saves:* ${d.totalSaves} | *New followers:* ${d.totalNewFollowers}
*Score:* median ${fmt(d.scoreStats.median)}, mean ${fmt(d.scoreStats.mean)}, stddev ${fmt(d.scoreStats.stddev)}
*IQR:* ${fmt(d.scoreStats.p25)}–${fmt(d.scoreStats.p75)} | *Range:* ${fmt(d.scoreStats.min)}–${fmt(d.scoreStats.max)}${d.avgWordCount ? ` | *Avg words:* ${d.avgWordCount}` : ''}

*Performance trend:*
${trendStr}
${recentSection}
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

*By time window — experiment (ET):*
${d.windowRanking.map(rankLine).join('\n')}
${photoLine}${wcSection}${outlierLines ? `\n\n*Outliers:*\n${outlierLines}` : ''}

*Best post:* [${d.bestPost?.postType}] ${d.bestPost?.snippet}…
_Score: ${d.bestPost ? fmt(d.bestPost.score) : 'n/a'}${d.bestPost?.impressions ? ` · ${d.bestPost.impressions.toLocaleString()} impressions` : ''}_`;
}
