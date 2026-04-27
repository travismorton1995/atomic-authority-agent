// PDF report orchestrator — computes data, generates charts, calls LLM for insights,
// invokes Python generate-pdf.py, returns a PDF buffer.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { generateReportData, type ReportData } from './report.js';
import { getAttributionSummary, type AttributionSummary } from './attribution.js';
import { getOrganicAttribution, type OrganicAttributionData } from './organic-attribution.js';
import { getFollowerData } from './followers.js';
import { loadPostsWithMetrics } from './post-data.js';
import { compositeScore } from './post-data.js';

function loadHashtagTrends(): any {
  try {
    if (!existsSync('hashtag_trends.json')) return null;
    const raw = JSON.parse(readFileSync('hashtag_trends.json', 'utf-8'));
    // Convert to sorted array: [{tag, count, profiles, lastSeen}]
    const entries = Object.entries(raw).map(([tag, entry]: [string, any]) => ({
      tag,
      count: entry.count,
      profileCount: Object.keys(entry.profiles).length,
      topProfiles: Object.entries(entry.profiles)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]: any) => name),
      lastSeen: entry.lastSeen,
    }));
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, 15); // top 15
  } catch {
    return null;
  }
}
import {
  generateFollowerChart,
  generatePostTypeChart,
  generateHeatmapChart,
  generateScoreTrendChart,
  generateTagChart,
} from './chart.js';

const anthropic = new Anthropic();
const HISTORY_FILE = 'posted_history.json';

/** Download a URL to a local file. Follows redirects. Returns true on success. */
function downloadFile(url: string, dest: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { timeout: timeoutMs }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest, timeoutMs).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        resolve(false);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) { resolve(false); return; } // too small = error page
        writeFileSync(dest, buffer);
        resolve(true);
      });
      res.on('error', () => resolve(false));
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

interface TopPost {
  rank: number;
  title: string;
  hookText: string;
  bodyText: string;
  postType: string;
  compositeScore: number;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number;
  newFollowers: number;
  indirectFollowers: number;
  publishedAt: string;
  imageChoice: string;
  imagePath: string | null;
}

interface PdfData {
  reportDate: string;
  dateRange: string;
  kpis: Record<string, any>;
  charts: Record<string, string>;
  dayRanking: any[];
  windowRanking: any[];
  hashtagRanking: any[];
  tagRanking: any[];
  feedRanking: any[];
  typeRanking: any[];
  photoEntries: any[];
  recent: any;
  allTimeAvgScore: number;
  wordCountBuckets: Record<string, { median: number; count: number; significant: boolean }> | null;
  correlations: any[];
  topPosts: TopPost[];
  attribution: any;
  organicAttribution: any;
  outboundStats: any;
  hashtagTrends: any;
  recentPostsTable: any[];
  insights: any[];
}

/** Build the top 3 posts from the last 30 days with image paths resolved. */
async function buildTopPosts(tmpDir: string): Promise<TopPost[]> {
  if (!existsSync(HISTORY_FILE)) return [];

  let history: any[];
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = history.filter((p: any) =>
    p.status === 'published' &&
    p.metrics &&
    p.publishedAt &&
    new Date(p.publishedAt).getTime() >= cutoff
  );

  // Load indirect-only follower attribution (total attributed minus LinkedIn direct)
  const indirectMap = new Map<string, number>();
  try {
    const organic = getOrganicAttribution();
    if (organic) {
      for (const entry of organic.postRollup) {
        const indirectOnly = Math.max(0, entry.totalAttributed - entry.linkedInAttributed);
        indirectMap.set(entry.id, indirectOnly);
      }
    }
  } catch { /* graceful */ }

  const scored = recent.map((p: any) => ({
    raw: p,
    indirect: indirectMap.get(p.id) ?? 0,
    score: compositeScore(p.metrics, indirectMap.get(p.id) ?? 0),
  })).sort((a, b) => b.score - a.score);

  return Promise.all(scored.slice(0, 3).map(async (entry, i) => {
    const p = entry.raw;
    const content: string = p.finalContent ?? '';
    const hook = content.split('\n')[0]?.replace(/\[\[MENTION:[^\]]+\]\]/g, (m: string) => {
      const name = m.match(/MENTION:([^\]]+)/)?.[1] ?? '';
      return name;
    }) ?? '';

    // Resolve image path — download URLs to temp dir
    let imagePath: string | null = null;
    const choice = p.imageChoice ?? 'none';

    if (choice === 'ai' && p.draft?.generatedImagePath) {
      const resolved = path.resolve(p.draft.generatedImagePath);
      if (existsSync(resolved)) imagePath = resolved;
    }
    if (!imagePath && choice === 'custom') {
      // Custom uploads are stored in either customImagePath or generatedImagePath
      const customPath = p.customImagePath ?? p.draft?.generatedImagePath;
      if (customPath) {
        const resolved = path.resolve(customPath);
        if (existsSync(resolved)) imagePath = resolved;
      }
    }
    if (!imagePath && choice === 'stock' && p.draft?.stockImageUrl) {
      const imgFile = path.join(tmpDir, `stock_${i}.jpg`);
      if (await downloadFile(p.draft.stockImageUrl, imgFile)) imagePath = imgFile;
    }
    if (!imagePath && choice === 'og' && p.draft?.imageUrl) {
      const imgFile = path.join(tmpDir, `og_${i}.jpg`);
      if (await downloadFile(p.draft.imageUrl, imgFile)) imagePath = imgFile;
    }
    // Final fallback: if no image resolved for the chosen type, try og:image
    if (!imagePath && p.draft?.imageUrl) {
      const imgFile = path.join(tmpDir, `og_${i}.jpg`);
      if (await downloadFile(p.draft.imageUrl, imgFile)) imagePath = imgFile;
    }

    // Clean body text — strip mention markers and hashtags
    const bodyText = content
      .replace(/\[\[MENTION:([^\]]+)\]\]/g, '$1')
      .replace(/#\w+/g, '')
      .trim();

    // Use stored title from draft, or generate one for older posts
    let title = p.draft?.title ?? '';
    if (!title) {
      try {
        const titleResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 30,
          messages: [{
            role: 'user',
            content: `Give this LinkedIn post a short internal title (3-5 words, no quotes, no punctuation).\n\n${hook}`,
          }],
        });
        title = (titleResp.content[0].type === 'text' ? titleResp.content[0].text : '').trim();
      } catch { /* use empty */ }
    }

    return {
      rank: i + 1,
      title,
      hookText: hook,
      bodyText,
      postType: p.draft?.postType ?? 'unknown',
      compositeScore: entry.score,
      impressions: p.metrics?.impressions ?? 0,
      reactions: p.metrics?.reactions ?? 0,
      comments: p.metrics?.comments ?? 0,
      reposts: p.metrics?.reposts ?? 0,
      saves: p.metrics?.saves ?? 0,
      newFollowers: p.metrics?.newFollowers ?? 0,
      indirectFollowers: entry.indirect,
      publishedAt: p.publishedAt ?? '',
      imageChoice: choice,
      imagePath,
    };
  }));
}

/** Compute outbound stats from outbound_state.json. */
function computeOutboundStats(): { totalCommentsPosted: number; uniqueProfilesCommented: number; avgCommentsPerDay: number } {
  const stateFile = 'outbound_state.json';
  if (!existsSync(stateFile)) return { totalCommentsPosted: 0, uniqueProfilesCommented: 0, avgCommentsPerDay: 0 };

  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const posted = (state.pendingComments ?? []).filter((c: any) => c.status === 'posted' && c.postedAt);
    const profiles = new Set(posted.map((c: any) => c.profileUrl));

    // Date range
    if (posted.length === 0) return { totalCommentsPosted: 0, uniqueProfilesCommented: 0, avgCommentsPerDay: 0 };
    const dates = posted.map((c: any) => new Date(c.postedAt).toISOString().slice(0, 10));
    const uniqueDates = new Set(dates);
    const daySpan = uniqueDates.size || 1;

    return {
      totalCommentsPosted: posted.length,
      uniqueProfilesCommented: profiles.size,
      avgCommentsPerDay: posted.length / daySpan,
    };
  } catch {
    return { totalCommentsPosted: 0, uniqueProfilesCommented: 0, avgCommentsPerDay: 0 };
  }
}

/** Call Claude for performance insights. */
async function generateInsights(data: ReportData, attribution: AttributionSummary | null): Promise<any[]> {
  try {
    const payload = {
      postCount: data.postCount,
      totalImpressions: data.totalImpressions,
      engRate: data.overallEngRate,
      scoreStats: data.scoreStats,
      trend: { direction: data.trend.direction, slope: data.trend.slope },
      typeRanking: data.typeRanking.slice(0, 5),
      dayRanking: data.dayRanking,
      windowRanking: data.windowRanking,
      photoEntries: data.photoEntries,
      recent: data.recent,
      allTimeAvgScore: data.allTimeAvgScore,
      correlations: data.correlations,
      followers: data.followers,
      attribution: attribution ? {
        overallLift: attribution.overallLift,
        controlledLift: attribution.controlledLift,
        commentDays: attribution.totalCommentDays,
        quietDays: attribution.totalQuietDays,
        topProfiles: attribution.profileScores.slice(0, 3).map(p => ({ name: p.profileName, lift: p.lift })),
      } : null,
    };

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a LinkedIn content strategist analyzing performance data for a nuclear/AI thought leadership account. Based on this data, generate exactly 4 insights as a JSON array.

Each insight must be:
- Specific to this data (reference actual numbers)
- Actionable (not just "keep doing X")
- Categorized as "working" (positive trend), "attention" (declining/concerning), or "recommendation" (strategic suggestion)

Format: [{"title": "...", "body": "...", "type": "working|attention|recommendation"}]

Constraints:
- Titles under 10 words
- Body 2-3 sentences, reference specific metrics
- At least one of each type if data supports it
- Do not use words like "transformative", "game-changer", "dive in", "delve"

Data:
${JSON.stringify(payload, null, 2)}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (err) {
    console.warn(`LLM insights failed: ${(err as Error).message}`);
  }
  return [];
}

/** Generate the full PDF report and return as a Buffer. */
export async function generatePdfReport(): Promise<Buffer> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'atomic-report-'));

  try {
    console.log('[pdf] Computing report data...');
    const reportData = generateReportData();
    const followerData = getFollowerData();

    // Generate charts
    console.log('[pdf] Generating charts...');
    const chartFiles: Record<string, string> = {};
    const chartGenerators: Array<[string, () => Promise<Buffer | null>]> = [
      ['followerGrowth', generateFollowerChart],
      ['postTypeDivergence', generatePostTypeChart],
      ['heatmap', generateHeatmapChart],
      // ['scoreTrend', generateScoreTrendChart],  // replaced by recent posts table on page 3
      ['tagPerformance', generateTagChart],
    ];

    for (const [name, fn] of chartGenerators) {
      try {
        const buf = await fn();
        if (buf) {
          const filePath = path.join(tmpDir, `${name}.png`);
          writeFileSync(filePath, buf);
          chartFiles[name] = filePath;
        }
      } catch (err) {
        console.warn(`[pdf] Chart "${name}" failed: ${(err as Error).message}`);
      }
    }

    // Top posts
    console.log('[pdf] Building top posts...');
    const topPosts = await buildTopPosts(tmpDir);

    // Recent posts table (newest first, up to 8)
    const allPosts = loadPostsWithMetrics();
    // Build title lookup from raw history
    const titleLookup = new Map<string, string>();
    try {
      const rawHistory: any[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      for (const p of rawHistory) {
        if (p.id && p.draft?.title) titleLookup.set(p.id, p.draft.title);
      }
    } catch { /* graceful */ }

    const recentPostsTable = [...allPosts]
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, 8)
      .map(p => ({
        date: p.publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' }),
        title: (titleLookup.get(p.id) ?? p.postSnippet).slice(0, 22),
        postType: p.postType,
        impressions: p.impressions,
        reactions: p.reactions,
        comments: p.comments,
        reposts: p.reposts,
        saves: p.saves,
        sends: p.sends,
        directFollows: p.newFollowers,
        indirectFollows: Math.round(p.indirectFollowers),
        compositeScore: Math.round(p.compositeScore),
      }));

    // Attribution
    let attribution: AttributionSummary | null = null;
    try {
      const summary = getAttributionSummary();
      if (summary.totalDays >= 5) attribution = summary;
    } catch { /* graceful */ }

    // Organic follow attribution
    let organicAttrPayload: any = null;
    try {
      const organicData = getOrganicAttribution();
      if (organicData && organicData.dailyAttributions.length > 0) {
        const totalGrowth = organicData.dailyAttributions.reduce((s, d) => s + d.followerDelta, 0);
        let postAttr = 0, commentAttr = 0, unattr = 0;
        for (const day of organicData.dailyAttributions) {
          unattr += day.unattributed;
          for (const item of day.items) {
            if (item.type === 'post') postAttr += item.attributedFollows;
            else commentAttr += item.attributedFollows;
          }
        }

        // Build per-post table: merge with LinkedIn direct follows
        const historyRaw: any[] = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')) : [];
        const directMap = new Map<string, { title: string; impressions: number; direct: number; postType: string }>();
        for (const p of historyRaw) {
          if (p.status === 'published' && p.metrics) {
            directMap.set(p.id, {
              title: (p.draft?.title ?? p.draft?.sourceTitle ?? '').slice(0, 38),
              impressions: p.metrics.impressions ?? 0,
              direct: p.metrics.newFollowers ?? 0,
              postType: p.draft?.postType ?? '',
            });
          }
        }

        const postRollup = organicData.postRollup.map(r => {
          const direct = directMap.get(r.id)?.direct ?? 0;
          const indirectOnly = Math.max(0, r.totalAttributed - direct);
          const totalFollows = r.totalAttributed; // already includes direct
          return {
            ...r,
            title: directMap.get(r.id)?.title ?? r.label,
            impressions: directMap.get(r.id)?.impressions ?? 0,
            directFollows: direct,
            indirectFollows: Math.round(indirectOnly * 10) / 10,
            totalFollows: Math.round(totalFollows * 10) / 10,
            postType: directMap.get(r.id)?.postType ?? '',
            efficiency: totalFollows > 0.5
              ? Math.round((directMap.get(r.id)?.impressions ?? 0) / totalFollows)
              : null,
          };
        });

        // Enrich profile rollup with impression data from outbound_state
        const stateFile = 'outbound_state.json';
        const profileImpressions = new Map<string, { total: number; count: number }>();
        if (existsSync(stateFile)) {
          try {
            const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
            for (const c of (state.pendingComments ?? [])) {
              if (c.status !== 'posted' || !c.commentImpressions) continue;
              const key = c.profileName;
              const existing = profileImpressions.get(key) ?? { total: 0, count: 0 };
              existing.total += c.commentImpressions;
              existing.count++;
              profileImpressions.set(key, existing);
            }
          } catch { /* graceful */ }
        }

        const enrichedProfileRollup = organicData.profileRollup.map(r => {
          const impr = profileImpressions.get(r.profileName);
          return {
            ...r,
            totalImpressions: impr?.total ?? 0,
            avgImpressions: impr ? Math.round(impr.total / impr.count) : 0,
          };
        });

        organicAttrPayload = {
          totalGrowth,
          postAttributed: Math.round(postAttr * 10) / 10,
          commentAttributed: Math.round(commentAttr * 10) / 10,
          unattributed: Math.round(unattr * 10) / 10,
          postRollup: postRollup.slice(0, 10),
          profileRollup: enrichedProfileRollup.slice(0, 10),
          daysTracked: organicData.dailyAttributions.length,
        };
      }
    } catch { /* graceful */ }

    // Outbound stats
    const outboundStats = computeOutboundStats();

    // LLM insights
    console.log('[pdf] Generating insights...');
    const insights = await generateInsights(reportData, attribution);

    // Build date range string — use follower history for full coverage (not just post dates)
    const posts = loadPostsWithMetrics();
    let dateRange = '';
    const fData = getFollowerData();
    if (fData && fData.snapshots.length >= 2) {
      const firstDate = new Date(fData.snapshots[0].date + 'T12:00:00');
      // Last activity date = second-to-last snapshot (last snapshot is today's measurement, not yet a complete day)
      const lastDate = new Date(fData.snapshots[fData.snapshots.length - 2].date + 'T12:00:00');
      const first = firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' });
      const last = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });
      dateRange = `${first} – ${last}`;
    } else if (posts.length > 0) {
      const sorted = [...posts].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
      const first = sorted[0].publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' });
      const last = sorted[sorted.length - 1].publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });
      dateRange = `${first} – ${last}`;
    }

    // Assemble JSON payload
    const pdfPayload: PdfData = {
      reportDate: new Date().toISOString().slice(0, 10),
      dateRange,
      kpis: {
        totalFollowers: followerData?.current ?? 0,
        followerGrowth: followerData?.allTimeGrowth ?? 0,
        weeklyFollowerGrowth: followerData?.weeklyGrowth ?? null,
        engagementRate: reportData.overallEngRate,
        totalImpressions: reportData.totalImpressions,
        avgImpressions: reportData.avgImpressions,
        totalReactions: reportData.totalReactions,
        totalComments: reportData.totalComments,
        totalReposts: reportData.totalReposts,
        compositeScoreTrend: reportData.trend.direction,
        trendSlopePerWeek: reportData.trend.slope * 7,
        trendRSquared: reportData.trend.rSquared,
        totalPosts: reportData.postCount,
        scoreStats: reportData.scoreStats,
      },
      charts: chartFiles,
      dayRanking: reportData.dayRanking,
      windowRanking: reportData.windowRanking,
      hashtagRanking: reportData.hashtagRanking,
      tagRanking: reportData.tagRanking,
      feedRanking: reportData.feedRanking,
      typeRanking: reportData.typeRanking,
      photoEntries: reportData.photoEntries.map(e => ({
        label: e.label,
        avg: e.stats.mean,
        median: e.stats.median,
        count: e.stats.n,
      })),
      recent: reportData.recent,
      allTimeAvgScore: reportData.allTimeAvgScore,
      wordCountBuckets: reportData.wordCountBuckets ? Object.fromEntries(
        Object.entries(reportData.wordCountBuckets)
          .filter(([, v]) => v.stats.n > 0)
          .map(([label, v]) => [label, { median: v.stats.median, count: v.stats.n, significant: v.significant }])
      ) : null,
      correlations: reportData.correlations,
      topPosts,
      recentPostsTable,
      attribution: attribution ? {
        totalDays: attribution.totalDays,
        totalCommentDays: attribution.totalCommentDays,
        totalQuietDays: attribution.totalQuietDays,
        avgDeltaCommentDays: attribution.avgDeltaCommentDays,
        avgDeltaQuietDays: attribution.avgDeltaQuietDays,
        overallLift: attribution.overallLift,
        overallConfidence: attribution.overallConfidence,
        controlledLift: attribution.controlledLift,
        controlledConfidence: attribution.controlledConfidence,
        topProfiles: attribution.profileScores.filter(p => p.commentDays >= 2).slice(0, 5).map(p => ({
          name: p.profileName,
          lift: p.lift,
          commentDays: p.commentDays,
          confidence: p.confidence,
          insider: p.insider,
          colleague: p.colleague,
        })),
        bottomProfiles: attribution.profileScores.filter(p => p.commentDays >= 2).slice(-3).reverse().map(p => ({
          name: p.profileName,
          lift: p.lift,
          commentDays: p.commentDays,
          confidence: p.confidence,
          insider: p.insider,
          colleague: p.colleague,
        })),
      } : null,
      organicAttribution: organicAttrPayload,
      outboundStats,
      hashtagTrends: loadHashtagTrends(),
      insights,
    };

    // Write JSON
    const dataPath = path.join(tmpDir, 'report_data.json');
    writeFileSync(dataPath, JSON.stringify(pdfPayload, null, 2), 'utf-8');

    // Call Python
    console.log('[pdf] Rendering PDF...');
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.resolve(scriptDir, '..', '..', 'src', 'analytics', 'generate-pdf.py');
    const outputPath = path.join(tmpDir, 'report.pdf');

    execSync(`python "${scriptPath}" "${dataPath}" "${outputPath}"`, {
      cwd: path.resolve('.'),
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!existsSync(outputPath)) {
      throw new Error('Python script did not produce output PDF');
    }

    const pdfBuffer = readFileSync(outputPath);
    console.log(`[pdf] PDF generated: ${pdfBuffer.length} bytes`);
    return Buffer.from(pdfBuffer);

  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
