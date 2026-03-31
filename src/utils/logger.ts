import { appendFileSync, existsSync, renameSync, statSync } from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('scheduler.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function rotate() {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size >= MAX_BYTES) {
    const rotated = LOG_FILE.replace(/\.log$/, '.log.1');
    renameSync(LOG_FILE, rotated);
  }
}

function timestamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function writeLine(level: string, args: unknown[]) {
  const line = `[${timestamp()}] [${level}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`;
  try {
    rotate();
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // Never throw from logger
  }
}

export function initLogger() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine('INFO', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine('WARN', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine('ERROR', args);
  };

  console.log(`Logger initialised — writing to ${LOG_FILE}`);
}
