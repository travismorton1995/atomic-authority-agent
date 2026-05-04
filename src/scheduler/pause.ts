// Pause state for the scheduler. When paused, all comment monitoring and
// metrics scraping is skipped. Generate, publish, first comment, and
// loopback continue running.
//
// Persisted to pause_state.json so the state survives restarts.

import { readFileSync, writeFileSync, existsSync } from 'fs';

const STATE_FILE = 'pause_state.json';

interface PauseState {
  paused: boolean;
  pausedAt: string | null;
  resumeAt: string | null;
  reason: string | null;
}

function load(): PauseState {
  if (!existsSync(STATE_FILE)) {
    return { paused: false, pausedAt: null, resumeAt: null, reason: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { paused: false, pausedAt: null, resumeAt: null, reason: null };
  }
}

function save(s: PauseState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** True if scheduler is currently paused (auto-resumes when resumeAt passes). */
export function isPaused(): boolean {
  const s = load();
  if (!s.paused) return false;
  if (s.resumeAt && Date.now() >= new Date(s.resumeAt).getTime()) {
    save({ paused: false, pausedAt: null, resumeAt: null, reason: null });
    console.log('[pause] Auto-resumed (resumeAt reached).');
    return false;
  }
  return true;
}

/** Pause the scheduler. Optional duration auto-resumes after N days. */
export function pauseScheduler(durationDays?: number, reason?: string): PauseState {
  const now = new Date();
  const resumeAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000)
    : null;
  const next: PauseState = {
    paused: true,
    pausedAt: now.toISOString(),
    resumeAt: resumeAt?.toISOString() ?? null,
    reason: reason ?? null,
  };
  save(next);
  return next;
}

/** Resume the scheduler immediately. */
export function resumeScheduler(): PauseState {
  const next: PauseState = { paused: false, pausedAt: null, resumeAt: null, reason: null };
  save(next);
  return next;
}

export function getPauseStatus(): PauseState {
  return load();
}
