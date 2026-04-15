// Enhanced weekly report generation using statistical analysis.
// All-time data for rankings + recent trend comparison.

import {
  groupStats, trendLine, detectOutliers, bucketCompare,
  robustAverage, confidenceWeightedScore,
  type GroupStats, type TrendResult,
} from './stats.js';
import { loadPostsWithMetrics, type PostAnalyticsRecord } from './post-data.js';
import { getCorrelationInsights, type CorrelationInsight } from './feedback.js';
import { getFollowerData } from './followers.js';

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
  followers: { current: number; allTimeGrowth: number; weeklyGrowth: number | null } | null;
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
  photoEntries: Array<{ label: string; emoji: string; stats: GroupStats }>;
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
  const followerData = getFollowerData();
  const followers = followerData ? {
    current: followerData.current,
    allTimeGrowth: followerData.allTimeGrowth,
    weeklyGrowth: followerData.weeklyGrowth,
  } : null;

  // Rankings (all-time)
  const typeRanking = rankBy(posts, p => p.postType);
  const tagRanking = rankBy(posts, p => p.contentTags);
  const hashtagRanking = rankBy(posts, p => p.hashtags);
  const feedRanking = rankBy(posts, p => p.sourceFeed);
  const dayRanking = rankBy(posts, p => p.dayOfWeek);
  const windowRanking = rankBy(posts, p => p.timeWindow);

  // Photo comparison — all image types
  const photoTypes: Array<{ key: string; label: string; emoji: string }> = [
    { key: 'og', label: 'OG', emoji: '🖼️' },
    { key: 'ai', label: 'AI', emoji: '🤖' },
    { key: 'custom', label: 'Uploaded', emoji: '📷' },
    { key: 'stock', label: 'Stock', emoji: '📸' },
    { key: 'none', label: 'None', emoji: '🚫' },
  ];
  const photoEntries: Array<{ label: string; emoji: string; stats: GroupStats }> = [];
  for (const pt of photoTypes) {
    const scores = posts.filter(p => p.imageChoice === pt.key).map(p => p.compositeScore);
    if (scores.length > 0) photoEntries.push({ label: pt.label, emoji: pt.emoji, stats: groupStats(scores) });
  }
  photoEntries.sort((a, b) => b.stats.median - a.stats.median);

  // Word count buckets — finer granularity
  const wcBuckets: Record<string, number[]> = {
    '<100': [], '100-120': [], '120-140': [], '140-160': [], '160-180': [], '180-200': [], '>200': [],
  };
  for (const p of posts) {
    if (p.wordCount < 100) wcBuckets['<100'].push(p.compositeScore);
    else if (p.wordCount < 120) wcBuckets['100-120'].push(p.compositeScore);
    else if (p.wordCount < 140) wcBuckets['120-140'].push(p.compositeScore);
    else if (p.wordCount < 160) wcBuckets['140-160'].push(p.compositeScore);
    else if (p.wordCount < 180) wcBuckets['160-180'].push(p.compositeScore);
    else if (p.wordCount <= 200) wcBuckets['180-200'].push(p.compositeScore);
    else wcBuckets['>200'].push(p.compositeScore);
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

  // Best post — last 14 days only
  const recentCutoff14 = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent14 = posts.filter(p => p.publishedAt.getTime() >= recentCutoff14);
  let bestPost: ReportData['bestPost'] = null;
  if (recent14.length > 0) {
    const recentScores = recent14.map(p => p.compositeScore);
    const bestIdx = recentScores.indexOf(Math.max(...recentScores));
    bestPost = {
      snippet: recent14[bestIdx].postSnippet,
      postType: recent14[bestIdx].postType,
      score: recent14[bestIdx].compositeScore,
      impressions: recent14[bestIdx].impressions,
    };
  }

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
    photoEntries, wordCountBuckets, outliers, bestPost, recent, followers,
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
    photoEntries: [], wordCountBuckets: null, outliers: [], bestPost: null, recent: null, followers: null,
  };
}

export function formatReportMessage(d: ReportData): string {
  if (d.postCount === 0) return '📊 No published posts with metrics yet.';

  const fmt = (n: number) => n.toFixed(1);
  const medals = ['🥇', '🥈', '🥉'];

  const rankLine = (r: RankEntry, i: number, maxLabelLen: number) => {
    const medal = medals[i] ?? '  •';
    const conf = r.confidence === 'low' ? ' ⚠️' : '';
    const label = r.label.slice(0, maxLabelLen).padEnd(maxLabelLen);
    return `${medal}<code> ${label} ${fmt(r.avg).padStart(5)} (${String(r.count).padStart(2)})</code>${conf}`;
  };

  const rankBlock = (entries: RankEntry[], labelLen = 14) =>
    entries.map((r, i) => rankLine(r, i, labelLen)).join('\n');

  // Followers
  let followerSection = '';
  if (d.followers) {
    const weeklyStr = d.followers.weeklyGrowth !== null
      ? `Weekly: +${d.followers.weeklyGrowth}`
      : 'Weekly: awaiting data';
    followerSection = `\n<b>Followers:</b> ${d.followers.current.toLocaleString()} total (+${d.followers.allTimeGrowth} since Mar 18) · ${weeklyStr}`;
  }

  // Trend
  const trendEmoji = d.trend.direction === 'improving' ? '📈' : d.trend.direction === 'declining' ? '📉' : '➡️';
  const trendStr = d.trend.direction === 'flat'
    ? `${trendEmoji} Flat`
    : `${trendEmoji} ${d.trend.direction.charAt(0).toUpperCase() + d.trend.direction.slice(1)} — ${d.trend.slope > 0 ? '+' : ''}${fmt(d.trend.slope * 7)}/week (R²=${fmt(d.trend.rSquared)})`;

  // Recent comparison
  let recentSection = '';
  if (d.recent && d.recent.postCount > 0) {
    const scoreDelta = d.recent.avgScore - d.allTimeAvgScore;
    const deltaEmoji = scoreDelta > 5 ? '🔼' : scoreDelta < -5 ? '🔽' : '➡️';
    recentSection = `\n<b>Last ${d.recent.periodDays}d</b> (${d.recent.postCount} posts): ${fmt(d.recent.avgScore)} avg ${deltaEmoji}
<code> Impressions  ${d.recent.avgImpressions.toLocaleString().padStart(6)}/post
 Eng rate     ${d.recent.engRate.padStart(5)}%</code>`;
  }

  // Filter rankings — require min count, sort by count desc then score desc, cap display
  const minCount = 2;
  const filterAndSort = (entries: RankEntry[], max = 8) =>
    entries
      .filter(r => r.count >= minCount)
      .sort((a, b) => b.count - a.count || b.avg - a.avg)
      .slice(0, max);
  const filteredTags = filterAndSort(d.tagRanking);
  const filteredHashtags = filterAndSort(d.hashtagRanking);
  const filteredFeeds = filterAndSort(d.feedRanking);

  // Word count buckets
  let wcSection = '';
  if (d.wordCountBuckets) {
    const lines = Object.entries(d.wordCountBuckets)
      .filter(([, v]) => v.stats.n > 0)
      .map(([label, v]) => {
        const conf = v.stats.n < 3 ? ' ⚠️' : '';
        return `<code> ${label.padEnd(16)} ${fmt(v.stats.median).padStart(5)} (${String(v.stats.n).padStart(2)})</code>${conf}`;
      })
      .join('\n');
    if (lines) wcSection = `\n<b>Word count:</b>\n${lines}`;
  }

  // Outliers
  const outlierLines = d.outliers
    .map(o => `${o.sigma > 0 ? '🚀' : '📉'} ${o.snippet.slice(0, 30)}… ${fmt(o.score)} (${fmt(Math.abs(o.sigma))}σ)`)
    .join('\n');

  // Photo comparison — sorted by median desc
  let photoLine = '';
  if (d.photoEntries.length > 0) {
    const parts = d.photoEntries.map(e =>
      `<code> ${e.emoji} ${e.label.padEnd(10)} ${fmt(e.stats.median).padStart(5)} (${String(e.stats.n).padStart(2)})</code>`
    );
    photoLine = `\n<b>Images:</b> (median score, count)\n${parts.join('\n')}`;
  }

  return `📊 <b>Performance Report</b>
Since ${d.firstPostDate} · ${d.postCount} posts

<code> Impressions  ${d.totalImpressions.toLocaleString().padStart(6)} (${d.avgImpressions.toLocaleString()}/post)
 Eng rate     ${d.overallEngRate.padStart(5)}%
 Reactions    ${String(d.totalReactions).padStart(6)}
 Comments     ${String(d.totalComments).padStart(6)}
 Reposts      ${String(d.totalReposts).padStart(6)}
 Saves        ${String(d.totalSaves).padStart(6)}</code>
${followerSection}

<b>Score:</b> med ${fmt(d.scoreStats.median)} · avg ${fmt(d.scoreStats.mean)} · sd ${fmt(d.scoreStats.stddev)}
IQR ${fmt(d.scoreStats.p25)}–${fmt(d.scoreStats.p75)} · range ${fmt(d.scoreStats.min)}–${fmt(d.scoreStats.max)}${d.avgWordCount ? ` · ${d.avgWordCount}w avg` : ''}

<b>Trend:</b> ${trendStr}
${recentSection}

<b>Post types:</b> (avg score, count)
${rankBlock(d.typeRanking)}

<b>Tags:</b> (min ${minCount} posts)
${filteredTags.length > 0 ? rankBlock(filteredTags) : '  <i>(insufficient data)</i>'}

<b>Hashtags:</b> (min ${minCount} posts)
${filteredHashtags.length > 0 ? rankBlock(filteredHashtags, 16) : '  <i>(insufficient data)</i>'}

<b>Feed:</b> (min ${minCount} posts)
${filteredFeeds.length > 0 ? rankBlock(filteredFeeds, 18) : '  <i>(insufficient data)</i>'}

<b>Day:</b>
${rankBlock(d.dayRanking, 10)}

<b>Time window (ET):</b>
${rankBlock(d.windowRanking, 14)}
${photoLine}${wcSection}${outlierLines ? `\n\n<b>Outliers:</b>\n${outlierLines}` : ''}

<b>Best (last 14d):</b>${d.bestPost ? ` [${d.bestPost.postType}] ${d.bestPost.snippet?.slice(0, 35)}…
Score ${fmt(d.bestPost.score)}${d.bestPost.impressions ? ` · ${d.bestPost.impressions.toLocaleString()} impr` : ''}` : ' <i>(no recent posts)</i>'}`;
}
