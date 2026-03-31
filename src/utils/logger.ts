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
  // Manual ET formatting — avoids toLocaleString quirks on Windows
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${et.getFullYear()}-${pad(et.getMonth() + 1)}-${pad(et.getDate())} ${pad(et.getHours())}:${pad(et.getMinutes())}:${pad(et.getSeconds())}`;
}

function sanitise(args: unknown[]): string {
  // Replace non-ASCII chars with ASCII equivalents to avoid encoding corruption
  return args.map(a => typeof a === 'string' ? a : JSON.stringify(a))
    .join(' ')
    .replace(/\u2014/g, '--')   // em dash
    .replace(/\u2013/g, '-')    // en dash
    .replace(/[^\x00-\x7F]/g, '?');
}

function writeLine(level: string, args: unknown[]) {
  const line = `[${timestamp()}] [${level}] ${sanitise(args)}\n`;
  try {
    rotate();
    appendFileSync(LOG_FILE, line, 'ascii');
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
