// Generates report charts as PNG buffers for Telegram.

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { getFollowerData } from './followers.js';
import { getOrganicAttribution } from './organic-attribution.js';
import { loadPostsWithMetrics } from './post-data.js';
import { POST_TYPE_WEIGHTS } from '../content/persona.js';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const WIDTH = 800;
const HEIGHT = 400;

const OUTBOUND_STATE_FILE = 'outbound_state.json';
const POSTED_HISTORY_FILE = 'posted_history.json';

function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

function makeCanvas(w = WIDTH, h = HEIGHT) {
  return new ChartJSNodeCanvas({ width: w, height: h, backgroundColour: '#ffffff' });
}

function loadCommentCountsByDate(): Map<string, number> {
  const byDate = new Map<string, number>();
  if (!existsSync(OUTBOUND_STATE_FILE)) return byDate;
  try {
    const state = JSON.parse(readFileSync(OUTBOUND_STATE_FILE, 'utf-8'));
    for (const c of state.pendingComments ?? []) {
      if (c.status !== 'posted' || !c.postedAt) continue;
      const date = toETDate(c.postedAt);
      byDate.set(date, (byDate.get(date) ?? 0) + 1);
    }
  } catch { /* graceful */ }
  return byDate;
}

function loadOwnPostDates(): Set<string> {
  const dates = new Set<string>();
  if (!existsSync(POSTED_HISTORY_FILE)) return dates;
  try {
    const posts: any[] = JSON.parse(readFileSync(POSTED_HISTORY_FILE, 'utf-8'));
    for (const p of posts) {
      if (p.publishedAt) dates.add(toETDate(p.publishedAt));
    }
  } catch { /* graceful */ }
  return dates;
}

const TYPE_COLORS: Record<string, string> = {
  bridge: '#4285F4', explainer: '#34A853', contrarian: '#EA4335',
  'change-management': '#FBBC04', 'myth-busting': '#8E24AA',
  'hot-take': '#FF6D00', prediction: '#00ACC1', insider: '#607D8B',
};

// ─── 1. Follower growth — stacked bar (post follows vs comment follows) + line ──

export async function generateFollowerChart(): Promise<Buffer | null> {
  const data = getFollowerData();
  if (!data || data.snapshots.length < 3) return null;

  const snapshots = data.snapshots;
  const attribution = getOrganicAttribution();

  // Build per-day attribution breakdown
  const attrByDate = new Map<string, { postFollows: number; commentFollows: number }>();
  if (attribution) {
    for (const day of attribution.dailyAttributions) {
      let postFollows = 0;
      let commentFollows = 0;
      for (const item of day.items) {
        if (item.type === 'post') postFollows += item.attributedFollows;
        else commentFollows += item.attributedFollows;
      }
      attrByDate.set(day.date, { postFollows, commentFollows });
    }
  }

  const labels = snapshots.map(s => {
    const d = new Date(s.date + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' });
  });

  const totals = snapshots.map(s => s.total);

  // Stacked bar data: post-driven follows (direct + indirect) and comment follows
  const postFollows = snapshots.map(s => {
    const attr = attrByDate.get(s.date);
    return attr ? Math.round(attr.postFollows * 10) / 10 : 0;
  });
  const commentFollows = snapshots.map(s => {
    const attr = attrByDate.get(s.date);
    return attr ? Math.round(attr.commentFollows * 10) / 10 : 0;
  });

  // For days with no attribution data, show the raw delta as unattributed (gray)
  const unattributed = snapshots.map((s, i) => {
    if (i === 0) return 0;
    const delta = s.total - snapshots[i - 1].total;
    const attr = attrByDate.get(s.date);
    if (!attr) return Math.max(0, delta);
    const accounted = attr.postFollows + attr.commentFollows;
    return Math.max(0, Math.round((delta - accounted) * 10) / 10);
  });

  const canvas = makeCanvas();
  const buffer = await canvas.renderToBuffer({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'line' as const, label: 'Total Followers', data: totals,
          borderColor: '#1B2A4A', backgroundColor: 'rgba(27, 42, 74, 0.05)',
          fill: true, tension: 0.3, pointRadius: 2, pointBackgroundColor: '#1B2A4A',
          yAxisID: 'y', order: 0,
        },
        {
          type: 'bar' as const, label: 'Post Follows', data: postFollows,
          backgroundColor: 'rgba(232, 136, 60, 0.85)', // amber
          yAxisID: 'y1', order: 1, stack: 'follows',
        },
        {
          type: 'bar' as const, label: 'Comment Follows', data: commentFollows,
          backgroundColor: 'rgba(42, 157, 143, 0.85)', // teal
          yAxisID: 'y1', order: 2, stack: 'follows',
        },
        {
          type: 'bar' as const, label: 'Unattributed', data: unattributed,
          backgroundColor: 'rgba(180, 180, 180, 0.4)',
          yAxisID: 'y1', order: 3, stack: 'follows',
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: `Follower Growth: ${totals[0]} → ${totals[totals.length - 1]} (+${totals[totals.length - 1] - totals[0]})`, font: { size: 16 } },
        legend: { display: true, labels: { font: { size: 11 } } },
      },
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: 'Total Followers' }, beginAtZero: false },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'Daily Follows' }, grid: { drawOnChartArea: false }, stacked: true },
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: 10 } } },
      },
    },
  });
  return Buffer.from(buffer);
}

// ─── 2. Post type divergence (actual − target %) ────────────────────

export async function generatePostTypeChart(): Promise<Buffer | null> {
  const posts = loadPostsWithMetrics();
  if (posts.length < 3) return null;

  const counts: Record<string, number> = {};
  for (const p of posts) {
    counts[p.postType] = (counts[p.postType] ?? 0) + 1;
  }

  const allTypes = [...new Set([...Object.keys(POST_TYPE_WEIGHTS), ...Object.keys(counts)])];

  // Divergence: actual% - target%
  const divergences = allTypes.map(t => {
    const actualPct = ((counts[t] ?? 0) / posts.length) * 100;
    const targetPct = (POST_TYPE_WEIGHTS as Record<string, number>)[t] ?? 0;
    return actualPct - targetPct;
  });

  const colors = divergences.map(d => d >= 0 ? 'rgba(234, 67, 53, 0.7)' : 'rgba(66, 133, 244, 0.7)');
  const borderColors = divergences.map(d => d >= 0 ? '#EA4335' : '#4285F4');

  const canvas = makeCanvas(WIDTH, 380);
  const buffer = await canvas.renderToBuffer({
    type: 'bar',
    data: {
      labels: allTypes,
      datasets: [{
        label: 'Actual − Target %',
        data: divergences,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: false,
      indexAxis: 'y',
      plugins: {
        title: { display: true, text: `Post Type Balance (${posts.length} posts) — red: over, blue: under`, font: { size: 14 } },
        legend: { display: false },
      },
      scales: {
        x: {
          title: { display: true, text: 'Divergence from target (percentage points)' },
          grid: { color: (ctx: any) => ctx.tick?.value === 0 ? '#333' : '#e0e0e0' },
        },
        y: { ticks: { font: { size: 12 } } },
      },
    },
  });
  return Buffer.from(buffer);
}

// ─── 3. Engagement heatmap (seaborn via Python) ─────────────────────

export async function generateHeatmapChart(): Promise<Buffer | null> {
  const posts = loadPostsWithMetrics();
  if (posts.length < 5) return null;

  const tmpFile = path.resolve('tmp_heatmap.png');
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // The .py file lives next to the .ts source, two levels up from dist/analytics/
  const scriptPath = path.resolve(scriptDir, '..', '..', 'src', 'analytics', 'heatmap.py');

  try {
    execSync(`python "${scriptPath}" "${tmpFile}"`, {
      cwd: path.resolve('.'),
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!existsSync(tmpFile)) return null;
    const buffer = readFileSync(tmpFile);
    unlinkSync(tmpFile);
    return Buffer.from(buffer);
  } catch (err) {
    console.warn(`Heatmap Python script failed: ${(err as Error).message}`);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    return null;
  }
}

// ─── 4. Score trend (composite score per post over time) ────────────

export async function generateScoreTrendChart(): Promise<Buffer | null> {
  const posts = loadPostsWithMetrics();
  if (posts.length < 3) return null;

  const sorted = [...posts].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

  const labels = sorted.map(p =>
    p.publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' })
  );
  const scores = sorted.map(p => p.compositeScore);
  const types = sorted.map(p => p.postType);
  const pointColors = types.map(t => TYPE_COLORS[t] ?? '#9E9E9E');

  // Moving average (3-post window)
  const ma: (number | null)[] = scores.map((_, i) => {
    if (i < 2) return null;
    return (scores[i] + scores[i - 1] + scores[i - 2]) / 3;
  });

  const canvas = makeCanvas();
  const buffer = await canvas.renderToBuffer({
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Composite Score',
          data: scores,
          borderColor: 'rgba(66, 133, 244, 0.4)',
          backgroundColor: 'rgba(66, 133, 244, 0.1)',
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: 6,
          pointHoverRadius: 8,
          fill: false,
          tension: 0,
        },
        {
          label: '3-post Moving Avg',
          data: ma,
          borderColor: '#EA4335',
          borderWidth: 2,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: 'Score Trend (colored by post type)', font: { size: 16 } },
        legend: { display: true, labels: { font: { size: 11 } } },
      },
      scales: {
        y: { title: { display: true, text: 'Composite Score' }, beginAtZero: true },
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
      },
    },
  });
  return Buffer.from(buffer);
}

// ─── 5. Tag performance (horizontal bar, sorted by score) ───────────

export async function generateTagChart(): Promise<Buffer | null> {
  const posts = loadPostsWithMetrics();
  if (posts.length < 5) return null;

  const tagScores: Record<string, number[]> = {};
  for (const p of posts) {
    for (const tag of p.contentTags) {
      if (!tagScores[tag]) tagScores[tag] = [];
      tagScores[tag].push(p.compositeScore);
    }
  }

  // Min 2 posts, sorted by avg score descending
  const ranked = Object.entries(tagScores)
    .filter(([, v]) => v.length >= 2)
    .map(([tag, values]) => ({
      tag,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      count: values.length,
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 12);

  if (ranked.length < 3) return null;

  const globalAvg = ranked.reduce((s, r) => s + r.avg, 0) / ranked.length;

  const labels = ranked.map(r => `${r.tag} (${r.count})`);
  const scores = ranked.map(r => r.avg);
  const colors = ranked.map(r =>
    r.avg >= globalAvg ? 'rgba(52, 168, 83, 0.7)' : 'rgba(234, 67, 53, 0.5)'
  );

  const chartHeight = Math.max(350, ranked.length * 32);
  const canvas = makeCanvas(WIDTH, chartHeight);
  const buffer = await canvas.renderToBuffer({
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Avg Composite Score',
        data: scores,
        backgroundColor: colors,
        borderColor: colors.map(c => c.replace(/[\d.]+\)$/, '1)')),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: false,
      indexAxis: 'y',
      plugins: {
        title: { display: true, text: 'Tag Performance (avg composite score, min 2 posts)', font: { size: 14 } },
        legend: { display: false },
      },
      scales: {
        x: { title: { display: true, text: 'Avg Composite Score' }, beginAtZero: true },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  return Buffer.from(buffer);
}

// ─── Export all charts for the report ────────────────────────────────

export interface ChartResult {
  name: string;
  buffer: Buffer;
  caption: string;
}

export async function generateAllCharts(): Promise<ChartResult[]> {
  const results: ChartResult[] = [];

  const charts: Array<{ name: string; fn: () => Promise<Buffer | null>; caption: string }> = [
    { name: 'followers', fn: generateFollowerChart, caption: 'Follower growth — amber: post follows, teal: comment follows, gray: unattributed' },
    { name: 'types', fn: generatePostTypeChart, caption: 'Post type balance — red: over target, blue: under target' },
    { name: 'heatmap', fn: generateHeatmapChart, caption: 'Engagement heatmap — day × time, color: composite score' },
    { name: 'trend', fn: generateScoreTrendChart, caption: 'Score trend — dots colored by post type, red: 3-post moving avg' },
    { name: 'tags', fn: generateTagChart, caption: 'Tag performance — green: above avg, red: below avg' },
  ];

  for (const chart of charts) {
    try {
      const buf = await chart.fn();
      if (buf) results.push({ name: chart.name, buffer: buf, caption: chart.caption });
    } catch (err) {
      console.warn(`Chart "${chart.name}" failed: ${(err as Error).message}`);
    }
  }

  return results;
}
