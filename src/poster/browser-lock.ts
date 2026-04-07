// Shared mutex for LinkedIn browser operations.
// Only one Playwright persistent context can use user_data/ at a time.
// All browser operations should acquire this lock before launching.

let currentLock: Promise<void> = Promise.resolve();

/**
 * Acquires the browser lock. Returns a release function that MUST be called
 * when the browser context is closed (use in a finally block).
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
export async function acquireBrowserLock(): Promise<() => void> {
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const previous = currentLock;
  currentLock = next;
  await previous;
  return release!;
}
