// Shared mutex for LinkedIn browser operations.
// Only one Playwright persistent context can use user_data/ at a time.
// All browser operations queue here and wait their turn.

let currentLock: Promise<void> = Promise.resolve();

// Default 10-minute safety timeout — prevents permanent deadlock if a lock is never released.
// Under normal operation, locks are held for seconds to minutes. This is just a safety net.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Acquires the browser lock. Waits in a queue until the previous holder releases.
 * Returns a release function that MUST be called when the browser context is closed.
 *
 * @param timeoutMs — Safety timeout (default: 10 minutes). Only fails if a previous
 *                    lock holder is truly stuck. Under normal operation, this never fires.
 */
export async function acquireBrowserLock(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<() => void> {
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const previous = currentLock;
  currentLock = next;

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Browser lock not acquired within ${timeoutMs}ms — possible deadlock`)), timeoutMs),
  );
  try {
    await Promise.race([previous, timeout]);
  } catch (err) {
    // Release our slot in the chain so subsequent waiters aren't stuck forever.
    release!();
    throw err;
  }

  return release!;
}
