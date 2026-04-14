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

/** Returns true if within the Friday prompt window specifically (day 5 = Friday). */
export function isFridayPromptWindow(): boolean {
  const now = new Date();
  const isFriday = now.getDay() === 5;
  return isFriday && isWithinPromptWindow();
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
 * Assembles the week's notes into a formatted text block WITHOUT clearing them.
 * Notes are only cleared after the insider post is published (via clearNotes).
 * Returns null if fewer than minNotes were captured (not enough for a post).
 */
export function assembleNotes(minNotes = 2): string | null {
  const state = load();
  if (state.notes.length < minNotes) {
    console.log(`[daily-notes] Only ${state.notes.length} note(s) this week (need ${minNotes}) — skipping assembly.`);
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

  state.lastAssemblyAt = new Date().toISOString();
  save(state);

  console.log(`[daily-notes] Assembled ${lines.length} note(s) for insider post.`);
  return assembled;
}

/** Clear all notes. Call this only after the insider post is published. */
export function clearNotes(): void {
  const state = load();
  state.notes = [];
  save(state);
  console.log('[daily-notes] Notes cleared.');
}

/**
 * If 2+ notes exist and within the Friday prompt window, assemble and
 * run the insider pipeline immediately. Returns true if generation started.
 */
export async function tryAssembleAndGenerate(): Promise<boolean> {
  const state = load();
  if (state.notes.length < 2) return false;

  const notes = assembleNotes();
  if (!notes) return false;

  const { runInsiderPipeline } = await import('../content/pipeline.js');
  await runInsiderPipeline(notes);
  return true;
}

/** Send the daily notes prompt (Mon–Thu) to the configured Telegram chat. */
export async function sendDailyPrompt(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[daily-notes] Telegram not configured — skipping daily prompt.');
    return;
  }

  const sender = new Telegraf(token);
  const count = getNoteCount();
  const countLine = count > 0 ? ` (${count} this week)` : '';
  await sender.telegram.sendMessage(
    chatId,
    `📝 *Daily Notes*${countLine}\n\nWhat are you working on today? Any challenges, insights, or observations?\n\n_Reply to this message or use /notes._`,
    { parse_mode: 'Markdown' },
  );
  markPromptSent();
  console.log('[daily-notes] Daily prompt sent.');
}

/** Send the Friday insider check-in prompt. Reply triggers insider post generation. */
export async function sendFridayPrompt(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[daily-notes] Telegram not configured — skipping Friday prompt.');
    return;
  }

  const sender = new Telegraf(token);
  const count = getNoteCount();
  const countLine = count > 0 ? `\n\n📊 ${count} note(s) collected so far this week.` : '';
  await sender.telegram.sendMessage(
    chatId,
    `📝 *Weekly Insider Check-in*\n\nAny final notes from this week? Challenges, insights, observations?${countLine}\n\n_Reply here or use /notes. Once you reply, I'll generate your insider post if there are 2+ notes._`,
    { parse_mode: 'Markdown' },
  );
  markPromptSent();
  console.log('[daily-notes] Friday insider prompt sent.');
}
