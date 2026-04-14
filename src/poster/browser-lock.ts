// Shared mutex for LinkedIn browser operations.
// Only one Playwright persistent context can use user_data/ at a time.
// All browser operations should acquire this lock before launching.

let currentLock: Promise<void> = Promise.resolve();

/**
 * Acquires the browser lock. Returns a release function that MUST be called
 * when the browser context is closed (use in a finally block).
 *
 * @param timeoutMs — Maximum time to wait for the lock (default: no timeout).
 *                    Throws if the lock isn't acquired within this time.
 *
 * Usage:
 *   const release = await acquireBrowserLock();
 *   try {
 *     const context = await chromium.launchPersistentContext(...);
 *     // ... do work ...
 *     await context.close();
 *   } finally {
 *     release();
 *   }
 */
export async function acquireBrowserLock(timeoutMs?: number): Promise<() => void> {
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const previous = currentLock;
  currentLock = next;

  if (timeoutMs != null) {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Browser lock not acquired within ${timeoutMs}ms`)), timeoutMs),
    );
    try {
      await Promise.race([previous, timeout]);
    } catch (err) {
      // Release our slot in the chain so subsequent waiters aren't stuck forever.
      release!();
      throw err;
    }
  } else {
    await previous;
  }

  return release!;
}
