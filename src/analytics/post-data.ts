// Canonical composite score and post data extraction.
// Single source of truth for score weights and history loading.

import { readFileSync, existsSync } from 'fs';
import { getOrganicAttribution } from './organic-attribution.js';

const HISTORY_FILE = 'posted_history.json';

/** Weights for composite performance score — values audience growth potential. */
export const SCORE_WEIGHTS = {
  newFollowers: 10,
  reposts: 5,
  sends: 5,
  comments: 3,
  saves: 3,
  reactions: 1,
  impressions: 0.01,
};

/** Compute the weighted composite score from post metrics + optional indirect followers. */
export function compositeScore(m: any, indirectFollowers: number = 0): number {
  if (!m) return 0;
  return ((m.newFollowers ?? 0) + indirectFollowers) * SCORE_WEIGHTS.newFollowers
       + (m.reposts ?? 0)      * SCORE_WEIGHTS.reposts
       + (m.sends ?? 0)        * SCORE_WEIGHTS.sends
       + (m.comments ?? 0)     * SCORE_WEIGHTS.comments
       + (m.saves ?? 0)        * SCORE_WEIGHTS.saves
       + (m.reactions ?? 0)    * SCORE_WEIGHTS.reactions
       + (m.impressions ?? 0)  * SCORE_WEIGHTS.impressions;
}

export interface PostAnalyticsRecord {
  id: string;
  compositeScore: number;
  postType: string;
  wordCount: number;
  contentTags: string[];
  hashtags: string[];
  sourceFeed: string;
  cringeScore: number;
  publishedAt: Date;
  dayOfWeek: string;
  timeWindow: string;
  hourET: number;
  imageChoice: string;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number;
  sends: number;
  newFollowers: number;
  indirectFollowers: number;
  dayIndex: number; // days since first post (for trend analysis)
  postSnippet: string;
}

function getTimeWindow(hour: number, minute: number = 0): string {
  const total = hour * 60 + minute;
  if (total >= 420 && total < 540) return '7-9am';
  if (total >= 540 && total < 660) return '9-11am';
  if (total >= 660 && total < 780) return '11am-1pm';
  if (total >= 780 && total < 900) return '1-3pm';
  if (total >= 900 && total < 1020) return '3-5pm';
  if (total >= 1020 && total < 1140) return '5-7pm';
  if (total >= 1140 && total < 1260) return '7-9pm';
  return 'Other';
}

/** Load all published posts with metrics from posted_history.json. */
export function loadPostsWithMetrics(maxAgeDays?: number): PostAnalyticsRecord[] {
  if (!existsSync(HISTORY_FILE)) return [];

  let history: any[];
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }

  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;

  const withMetrics = history.filter((p: any) =>
    p.status === 'published' &&
    p.metrics &&
    p.publishedAt &&
    (!maxAgeDays || new Date(p.publishedAt).getTime() >= cutoff)
  );

  if (withMetrics.length === 0) return [];

  // Load indirect follower attribution per post
  const indirectMap = new Map<string, number>();
  try {
    const organic = getOrganicAttribution();
    if (organic) {
      for (const entry of organic.postRollup) {
        indirectMap.set(entry.id, entry.totalAttributed);
      }
    }
  } catch { /* graceful */ }

  // Find earliest publish date for dayIndex calculation
  const earliest = Math.min(...withMetrics.map((p: any) => new Date(p.publishedAt).getTime()));

  return withMetrics.map((p: any) => {
    const pubDate = new Date(p.publishedAt);
    const hourET = parseInt(pubDate.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }), 10);
    const minET = parseInt(pubDate.toLocaleString('en-US', { timeZone: 'America/Toronto', minute: 'numeric' }), 10);
    const dayOfWeek = pubDate.toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short' });
    const content: string = p.finalContent ?? '';
    const hashtags = (content.match(/#\w+/g) ?? []).map((t: string) => t.toLowerCase());
    const wc = p.wordCount ?? content.split(/\s+/).filter(Boolean).length;

    const indirect = indirectMap.get(p.id) ?? 0;

    return {
      id: p.id,
      compositeScore: compositeScore(p.metrics, indirect),
      postType: p.draft?.postType ?? 'unknown',
      wordCount: wc,
      contentTags: p.draft?.contentTags ?? [],
      hashtags,
      sourceFeed: p.draft?.sourceFeed ?? 'Unknown',
      cringeScore: p.screening?.cringeScore ?? 0,
      publishedAt: pubDate,
      dayOfWeek,
      timeWindow: getTimeWindow(hourET, minET),
      hourET,
      imageChoice: p.imageChoice === 'custom' ? 'custom'
        : p.imageChoice
        ?? (p.draft?.generatedImagePath ? 'ai' : undefined)
        ?? (p.draft?.imageUrl ? 'og' : 'none'),
      impressions: p.metrics?.impressions ?? 0,
      reactions: p.metrics?.reactions ?? 0,
      comments: p.metrics?.comments ?? 0,
      reposts: p.metrics?.reposts ?? 0,
      saves: p.metrics?.saves ?? 0,
      sends: p.metrics?.sends ?? 0,
      newFollowers: p.metrics?.newFollowers ?? 0,
      indirectFollowers: indirect,
      dayIndex: (pubDate.getTime() - earliest) / (1000 * 60 * 60 * 24),
      postSnippet: content.split('\n')[0]?.slice(0, 80) ?? '',
    };
  });
}
