import type { Page } from "@playwright/test";

/** Sample an idle page before timed work so monitor/compositor cadence is explicit. */
export async function measureFrameCadence(page: Page, frames = 60) {
  if (!Number.isInteger(frames) || frames < 2)
    throw new Error("Frame sampling needs at least two intervals");
  return page.evaluate(
    (frames) =>
      new Promise<{ p50Ms: number; p95Ms: number; visibility: DocumentVisibilityState }>(
        (resolve) => {
          const timestamps: number[] = [];
          const sample = (timestamp: number): void => {
            timestamps.push(timestamp);
            if (timestamps.length <= frames) {
              requestAnimationFrame(sample);
              return;
            }
            const intervals = timestamps
              .slice(1)
              .map((time, index) => time - timestamps[index])
              .sort((a, b) => a - b);
            resolve({
              p50Ms: intervals[Math.floor(intervals.length * 0.5)],
              p95Ms: intervals[Math.floor(intervals.length * 0.95)],
              visibility: document.visibilityState,
            });
          };
          requestAnimationFrame(sample);
        },
      ),
    frames,
  );
}
