type Window = { hour: number; minuteMin: number; minuteMax: number };

export const WINDOWS: Window[] = [
  { hour: 7, minuteMin: 30, minuteMax: 59 },
  { hour: 12, minuteMin: 0, minuteMax: 59 },
  { hour: 17, minuteMin: 0, minuteMax: 89 },
];

export function pickPostTime(): { hour: number; minute: number } {
  const window = WINDOWS[Math.floor(Math.random() * WINDOWS.length)];
  const minuteOffset = Math.floor(Math.random() * (window.minuteMax - window.minuteMin + 1)) + window.minuteMin;
  const totalMinutes = window.hour * 60 + minuteOffset;
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

const MIN_BUFFER_MINUTES = 60; // must be at least this far in the future

function nextWeekday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (day === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return d;
}

// Returns the next available posting slot as an ISO timestamp (Eastern time).
// Only picks from windows that are at least MIN_BUFFER_MINUTES in the future.
// If no windows remain today, picks from tomorrow (or Monday if weekend).
export function pickScheduledTime(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const bufferMs = MIN_BUFFER_MINUTES * 60 * 1000;

  // Build candidate times for today from eligible windows
  const todayCandidates: Date[] = [];
  for (const w of WINDOWS) {
    const minuteOffset = Math.floor(Math.random() * (w.minuteMax - w.minuteMin + 1)) + w.minuteMin;
    const totalMinutes = w.hour * 60 + minuteOffset;
    const candidate = new Date(nowET);
    candidate.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
    if (candidate.getTime() - nowET.getTime() >= bufferMs) {
      todayCandidates.push(candidate);
    }
  }

  if (todayCandidates.length > 0) {
    // Pick randomly from eligible windows today
    const picked = todayCandidates[Math.floor(Math.random() * todayCandidates.length)];
    return picked.toISOString();
  }

  // No windows left today — pick any window on the next weekday
  const tomorrow = nextWeekday(nowET);
  const { hour, minute } = pickPostTime();
  tomorrow.setHours(hour, minute, 0, 0);
  return tomorrow.toISOString();
}
