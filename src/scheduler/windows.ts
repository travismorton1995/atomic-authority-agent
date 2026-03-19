// Day-specific posting windows (Eastern time)
// Generation runs Mon/Tue/Wed evenings → posts go out Tue/Wed/Thu mornings
// 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

interface DayWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

// Primary morning windows per posting day
const DAY_WINDOWS: Record<number, DayWindow> = {
  2: { startHour: 8,  startMinute: 30, endHour: 10, endMinute: 45 }, // Tuesday
  3: { startHour: 9,  startMinute: 15, endHour: 11, endMinute: 30 }, // Wednesday
  4: { startHour: 10, startMinute: 0,  endHour: 13, endMinute: 0  }, // Thursday
};

// Secondary afternoon window — good for contrarian/discussion posts
const AFTERNOON_WINDOW: DayWindow = { startHour: 14, startMinute: 0, endHour: 15, endMinute: 30 };

// Days we post on (Tue/Wed/Thu)
const POSTING_DAYS = [2, 3, 4];

function pickTimeInWindow(w: DayWindow): { hour: number; minute: number } {
  const startTotal = w.startHour * 60 + w.startMinute;
  const endTotal = w.endHour * 60 + w.endMinute;
  const picked = startTotal + Math.floor(Math.random() * (endTotal - startTotal));
  return { hour: Math.floor(picked / 60), minute: picked % 60 };
}

// Legacy export — used by scheduler for generation time reference
export function pickPostTime(): { hour: number; minute: number } {
  const windows = Object.values(DAY_WINDOWS);
  const w = windows[Math.floor(Math.random() * windows.length)];
  return pickTimeInWindow(w);
}

function nextPostingDay(fromDate: Date): Date {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + 1);
  // Advance until we land on a posting day (Tue/Wed/Thu)
  while (!POSTING_DAYS.includes(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Returns the next posting slot as an ISO timestamp (Eastern time).
// Always targets the NEXT posting day (Tue/Wed/Thu) — approval happens the evening before.
// Picks from that day's specific window. Falls back to the afternoon window ~20% of the time.
export function pickScheduledTime(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const target = nextPostingDay(nowET);
  const dayOfWeek = target.getDay();

  const useAfternoon = Math.random() < 0.2;
  const window = useAfternoon ? AFTERNOON_WINDOW : (DAY_WINDOWS[dayOfWeek] ?? DAY_WINDOWS[2]);
  const { hour, minute } = pickTimeInWindow(window);

  target.setHours(hour, minute, 0, 0);
  return target.toISOString();
}
