import type { Page } from "@playwright/test";

async function withBrowserFallback<T>(
  operation: () => Promise<T>,
  killBrowser: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser context shutdown stalled")), 1000);
      }),
    ]);
  } catch (error) {
    // CDP cannot interrupt every native renderer hang; terminate the owned tree.
    await killBrowser();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Attach before V8 can block; a late CDP attachment can wait behind the work. */
export async function createBenchmarkAbort(
  page: Page,
  killBrowser: () => Promise<void>,
): Promise<() => Promise<void>> {
  const context = page.context();
  const session = await withBrowserFallback(() => context.newCDPSession(page), killBrowser);
  return () =>
    withBrowserFallback(async () => {
      try {
        await session.send("Runtime.terminateExecution");
      } finally {
        // The outer owner awaits whole-process/profile cleanup separately when
        // context shutdown succeeds and the browser remains reusable.
        await context.close();
      }
    }, killBrowser);
}

/** Cancel timed-out work and await its owned-resource shutdown before returning. */
export async function withDeadline<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  description: () => string,
  abort: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: Promise<void> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${description()} exceeded ${milliseconds} ms`);
      reject(error);
      // Start cancellation before the caller can race cleanup against the stalled work.
      aborted = abort().catch((cleanupError: unknown) => {
        process.stderr.write(`Benchmark context cleanup failed: ${String(cleanupError)}\n`);
      });
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
    // The caller must not race its cleanup against the owned attempt shutdown.
    await aborted;
  }
}
