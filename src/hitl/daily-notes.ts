import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Telegraf } from 'telegraf';

const STATE_FILE = 'daily_notes.json';
const PROMPT_WINDOW_HOURS = 4;

interface DailyNote {
  text: string;
  timestamp: string;
}

interface DailyNotesState {
  notes: DailyNote[];
  lastPromptAt: string | null;
  lastAssemblyAt: string | null;
}

function load(): DailyNotesState {
  if (!existsSync(STATE_FILE)) {
    return { notes: [], lastPromptAt: null, lastAssemblyAt: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { notes: [], lastPromptAt: null, lastAssemblyAt: null };
  }
}

function save(state: DailyNotesState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Add a note with the current timestamp. */
export function addNote(text: string): void {
  const state = load();
  state.notes.push({ text, timestamp: new Date().toISOString() });
  save(state);
}

/** Returns true if a prompt was sent within the last PROMPT_WINDOW_HOURS. */
export function isWithinPromptWindow(): boolean {
  const state = load();
  if (!state.lastPromptAt) return false;
  const elapsed = Date.now() - new Date(state.lastPromptAt).getTime();
  return elapsed < PROMPT_WINDOW_HOURS * 60 * 60 * 1000;
}

/** Record that a daily prompt was just sent. */
export function markPromptSent(): void {
  const state = load();
  state.lastPromptAt = new Date().toISOString();
  save(state);
}

/** Returns the current note count. */
export function getNoteCount(): number {
  return load().notes.length;
}

/**
 * Assembles the week's notes into a formatted text block and clears them.
 * Returns null if fewer than 2 notes were captured (not enough for a post).
 */
export function assembleAndClear(): string | null {
  const state = load();
  if (state.notes.length < 2) {
    console.log(`[daily-notes] Only ${state.notes.length} note(s) this week — skipping assembly.`);
    return null;
  }

  // Format notes as dated entries
  const lines = state.notes.map(n => {
    const date = new Date(n.timestamp).toLocaleDateString('en-US', {
      timeZone: 'America/Toronto',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return `[${date}] ${n.text}`;
  });

  const assembled = lines.join('\n\n');

  // Clear notes and record assembly
  state.notes = [];
  state.lastAssemblyAt = new Date().toISOString();
  save(state);

  console.log(`[daily-notes] Assembled ${lines.length} note(s) for insider post.`);
  return assembled;
}

/** Send the daily prompt to the configured Telegram chat. */
export async function sendDailyPrompt(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[daily-notes] Telegram not configured — skipping daily prompt.');
    return;
  }

  const sender = new Telegraf(token);
  await sender.telegram.sendMessage(
    chatId,
    '📝 *Daily Notes*\n\nWhat are you working on today? Any challenges, insights, or observations?\n\n_Reply to this message with your notes. They\'ll be assembled into an insider post on Monday._',
    { parse_mode: 'Markdown' },
  );
  markPromptSent();
  console.log('[daily-notes] Daily prompt sent.');
}
