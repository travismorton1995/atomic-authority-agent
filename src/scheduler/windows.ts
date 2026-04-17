// Time window experiment — 5 buckets, even rotation.
// Posts go out Tue/Wed/Thu. Each post is assigned the least-used time window
// to ensure even distribution across buckets for meaningful A/B comparison.

import { readFileSync, existsSync } from 'fs';

interface TimeWindow {
  label: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

// The 5 experimental time windows (Eastern time)
export const TIME_WINDOWS: TimeWindow[] = [
  { label: '9-11am',  startHour: 9,  startMinute: 0, endHour: 11, endMinute: 0 },
  { label: '11am-1pm', startHour: 11, startMinute: 0, endHour: 13, endMinute: 0 },
  { label: '1-3pm',   startHour: 13, startMinute: 0, endHour: 15, endMinute: 0 },
  { label: '3-5pm',   startHour: 15, startMinute: 0, endHour: 17, endMinute: 0 },
  { label: '5-7pm',   startHour: 17, startMinute: 0, endHour: 19, endMinute: 0 },
];

// Days we post on (Tue/Wed/Thu)
const POSTING_DAYS = [2, 3, 4]; // 0=Sun, 1=Mon, ...

function pickTimeInWindow(w: TimeWindow): { hour: number; minute: number } {
  const startTotal = w.startHour * 60 + w.startMinute;
  const endTotal = w.endHour * 60 + w.endMinute;
  const picked = startTotal + Math.floor(Math.random() * (endTotal - startTotal));
  return { hour: Math.floor(picked / 60), minute: picked % 60 };
}

/** Count how many published posts landed in each time window. */
function getWindowCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of TIME_WINDOWS) counts.set(w.label, 0);

  const HISTORY_FILE = 'posted_history.json';
  if (!existsSync(HISTORY_FILE)) return counts;

  try {
    const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')) as any[];
    for (const post of history) {
      if (post.status !== 'published' || !post.publishedAt) continue;
      // Skip insider posts — they use their own posting logic
      if (post.draft?.postType === 'insider') continue;
      const pubDate = new Date(post.publishedAt);
      const hourET = parseInt(pubDate.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }), 10);
      const minET = parseInt(pubDate.toLocaleString('en-US', { timeZone: 'America/Toronto', minute: 'numeric' }), 10);
      const totalMin = hourET * 60 + minET;

      for (const w of TIME_WINDOWS) {
        const wStart = w.startHour * 60 + w.startMinute;
        const wEnd = w.endHour * 60 + w.endMinute;
        if (totalMin >= wStart && totalMin < wEnd) {
          counts.set(w.label, (counts.get(w.label) ?? 0) + 1);
          break;
        }
      }
    }
  } catch {
    // If history is unreadable, return zeroes — all windows equally eligible
  }

  return counts;
}

/** Pick the least-used time window. Ties broken randomly. */
function pickLeastUsedWindow(): TimeWindow {
  const counts = getWindowCounts();
  const minCount = Math.min(...counts.values());
  const candidates = TIME_WINDOWS.filter(w => counts.get(w.label) === minCount);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Legacy export — used by scheduler for generation time reference
export function pickPostTime(): { hour: number; minute: number } {
  const w = TIME_WINDOWS[Math.floor(Math.random() * TIME_WINDOWS.length)];
  return pickTimeInWindow(w);
}

function nextPostingDay(fromDate: Date): Date {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + 1);
  while (!POSTING_DAYS.includes(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Returns the next posting slot as an ISO timestamp (Eastern time).
// Picks the least-used time window to ensure even rotation across all 5 buckets.
export function pickScheduledTime(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const target = nextPostingDay(nowET);

  const window = pickLeastUsedWindow();
  const { hour, minute } = pickTimeInWindow(window);
  console.log(`[windows] Scheduled in "${window.label}" (least-used bucket)`);

  target.setHours(hour, minute, 0, 0);
  return target.toISOString();
}

/** Returns the next Sunday 7–8pm ET as an ISO timestamp for insider posts. */
export function pickInsiderScheduledTime(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const target = new Date(nowET);

  // Advance to next Sunday (or stay if Sunday and before 8pm)
  const daysUntilSunday = (7 - target.getDay()) % 7;
  if (daysUntilSunday === 0) {
    if (target.getHours() >= 20) target.setDate(target.getDate() + 7);
  } else {
    target.setDate(target.getDate() + daysUntilSunday);
  }

  // Random minute within 7:00–8:00 PM
  const minute = Math.floor(Math.random() * 60);
  target.setHours(19, minute, 0, 0);
  console.log(`[windows] Insider post scheduled for Sunday ${target.toLocaleString('en-US', { timeZone: 'America/Toronto' })}`);
  return target.toISOString();
}
