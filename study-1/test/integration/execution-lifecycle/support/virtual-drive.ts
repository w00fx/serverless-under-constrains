// Drives virtual time beside work that waits on it: one step at a time until the work settles,
// so every sleep and timer the work schedules fires in order, and a hung execution fails the test
// with a bound instead of hanging it.

/** A drive gives up after this many steps (more than any execution's total target in seconds). */
export const MAX_DRIVE_STEPS = 20_000;

/**
 * Steps time with `step` until `work` settles; the work's own result or rejection.
 *
 * @example
 * const outcome = await driveUntilSettled(() => time.advanceBy(1000), runner.run());
 */
export async function driveUntilSettled<T>(step: () => Promise<void>, work: Promise<T>): Promise<T> {
  const progress = { settled: false };
  const settled = work.finally(() => {
    progress.settled = true;
  });
  settled.catch(() => undefined);
  for (let count = 0; count < MAX_DRIVE_STEPS && !progress.settled; count += 1) {
    await step();
  }
  if (!progress.settled) {
    throw new Error(`the work did not settle in ${String(MAX_DRIVE_STEPS)} steps; expected it to`);
  }
  return settled;
}
