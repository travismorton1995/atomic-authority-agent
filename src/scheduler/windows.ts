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

// Returns the next available posting slot as an ISO timestamp (Eastern time).
// If today is a weekend, advances to Monday.
export function pickScheduledTime(): string {
  const now = new Date();

  // Determine target date — skip weekends
  let targetDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const day = targetDate.getDay(); // 0=Sun, 6=Sat
  if (day === 0) targetDate.setDate(targetDate.getDate() + 1); // Sun → Mon
  if (day === 6) targetDate.setDate(targetDate.getDate() + 2); // Sat → Mon

  const { hour, minute } = pickPostTime();
  targetDate.setHours(hour, minute, 0, 0);

  // If the picked time has already passed today, advance to next weekday
  if (targetDate <= now) {
    targetDate.setDate(targetDate.getDate() + 1);
    const nextDay = targetDate.getDay();
    if (nextDay === 0) targetDate.setDate(targetDate.getDate() + 1);
    if (nextDay === 6) targetDate.setDate(targetDate.getDate() + 2);
  }

  return targetDate.toISOString();
}
