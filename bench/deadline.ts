/** Abort the owned browser, rather than leaving a timed-out evaluation running. */
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
      // The abort owns the browser process: graceful context close can wait on a blocked renderer.
      aborted = abort().catch((cleanupError: unknown) => {
        process.stderr.write(`Benchmark context cleanup failed: ${String(cleanupError)}\n`);
      });
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
    // The caller must not race its context cleanup against the owned process shutdown.
    await aborted;
  }
}
