// Pure statistical helpers wrapping simple-statistics.
// No codebase dependencies — data in, numbers out.

import * as ss from 'simple-statistics';

export interface GroupStats {
  mean: number;
  median: number;
  stddev: number;
  iqr: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  n: number;
}

export type Confidence = 'low' | 'medium' | 'high';

export interface ConfidenceScore {
  score: number;
  confidence: Confidence;
  n: number;
  stderr: number;
}

export interface CorrelationResult {
  r: number;
  rSquared: number;
  slope: number;
  intercept: number;
  significant: boolean;
}

export interface TrendResult {
  slope: number;
  intercept: number;
  rSquared: number;
  predict: (x: number) => number;
  direction: 'improving' | 'declining' | 'flat';
}

/** Outlier-resistant average. Median for small samples, trimmed mean for larger. */
export function robustAverage(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length < 5) return ss.median(values);

  // Trimmed mean: exclude values beyond 2 standard deviations
  const mean = ss.mean(values);
  const sd = ss.standardDeviation(values);
  if (sd === 0) return mean;

  const trimmed = values.filter(v => Math.abs(v - mean) <= 2 * sd);
  return trimmed.length > 0 ? ss.mean(trimmed) : mean;
}

/** Compute score with confidence classification based on sample size. */
export function confidenceWeightedScore(values: number[]): ConfidenceScore {
  if (values.length === 0) return { score: 0, confidence: 'low', n: 0, stderr: Infinity };

  const score = robustAverage(values);
  const n = values.length;
  const stderr = n > 1 ? ss.standardDeviation(values) / Math.sqrt(n) : Infinity;

  let confidence: Confidence;
  if (n < 3) confidence = 'low';
  else if (n < 6) confidence = 'medium';
  else confidence = 'high';

  return { score, confidence, n, stderr };
}

/** Full descriptive statistics for a set of values. */
export function groupStats(values: number[]): GroupStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, stddev: 0, iqr: 0, min: 0, max: 0, p25: 0, p75: 0, n: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const p25 = ss.quantile(sorted, 0.25);
  const p75 = ss.quantile(sorted, 0.75);

  return {
    mean: ss.mean(values),
    median: ss.median(sorted),
    stddev: ss.standardDeviation(values),
    iqr: p75 - p25,
    min: ss.min(values),
    max: ss.max(values),
    p25,
    p75,
    n: values.length,
  };
}

/** Pearson correlation with linear regression. Significant if |r| > 0.5 AND n >= 5. */
export function correlate(x: number[], y: number[]): CorrelationResult {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: 0, rSquared: 0, slope: 0, intercept: 0, significant: false };

  const pairs = x.slice(0, n).map((xi, i) => [xi, y[i]] as [number, number]);
  const r = ss.sampleCorrelation(x.slice(0, n), y.slice(0, n));
  const reg = ss.linearRegression(pairs);
  const regLine = ss.linearRegressionLine(reg);
  const rSq = ss.rSquared(pairs, regLine);

  return {
    r,
    rSquared: rSq,
    slope: reg.m,
    intercept: reg.b,
    significant: Math.abs(r) > 0.5 && n >= 5,
  };
}

/** Linear regression trend with direction classification. */
export function trendLine(points: Array<{ x: number; y: number }>): TrendResult {
  if (points.length < 3) {
    return { slope: 0, intercept: 0, rSquared: 0, predict: () => 0, direction: 'flat' };
  }

  const pairs = points.map(p => [p.x, p.y] as [number, number]);
  const reg = ss.linearRegression(pairs);
  const regLine = ss.linearRegressionLine(reg);
  const rSq = ss.rSquared(pairs, regLine);

  // Slope per week — if x is in days, multiply by 7
  const slopePerWeek = reg.m * 7;
  let direction: 'improving' | 'declining' | 'flat';
  if (Math.abs(slopePerWeek) < 0.5) direction = 'flat';
  else direction = slopePerWeek > 0 ? 'improving' : 'declining';

  return {
    slope: reg.m,
    intercept: reg.b,
    rSquared: rSq,
    predict: regLine,
    direction,
  };
}

/** Flag values more than 2 standard deviations from the mean. */
export function detectOutliers(values: number[]): { outlierIndices: number[]; threshold: number } {
  if (values.length < 3) return { outlierIndices: [], threshold: 0 };

  const mean = ss.mean(values);
  const sd = ss.standardDeviation(values);
  const threshold = 2 * sd;

  const outlierIndices = values
    .map((v, i) => Math.abs(v - mean) > threshold ? i : -1)
    .filter(i => i >= 0);

  return { outlierIndices, threshold };
}

/** Compare named buckets. Returns stats per bucket. */
export function bucketCompare(
  buckets: Record<string, number[]>
): Record<string, { stats: GroupStats; significant: boolean }> {
  const entries = Object.entries(buckets).filter(([, v]) => v.length > 0);
  if (entries.length < 2) {
    return Object.fromEntries(entries.map(([k, v]) => [k, { stats: groupStats(v), significant: false }]));
  }

  // Find best and worst bucket by median
  const withStats = entries.map(([k, v]) => ({ key: k, values: v, stats: groupStats(v) }));
  withStats.sort((a, b) => b.stats.median - a.stats.median);
  const best = withStats[0];
  const worst = withStats[withStats.length - 1];

  // Significance: practical check — both need 3+ values and medians must differ by > 1 stddev of the combined set
  const allValues = entries.flatMap(([, v]) => v);
  const combinedSd = ss.standardDeviation(allValues);
  const meaningfulDiff = Math.abs(best.stats.median - worst.stats.median) > combinedSd;
  const enoughData = best.values.length >= 3 && worst.values.length >= 3;
  const isSignificant = meaningfulDiff && enoughData;

  return Object.fromEntries(
    withStats.map(ws => [ws.key, { stats: ws.stats, significant: ws.key === best.key && isSignificant }])
  );
}
