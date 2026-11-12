/* Bounded density rendering replaces gesture-only resolution/row sampling.
 * Auto engages before expensive initial frames, or after measured slow frames.
 * The persisted "low" value remains compatible with older saved pages.
 */

/** How frames during a gesture are drawn: decided from measured frames, or forced. */
export type RenderQuality = "auto" | "low" | "full";

export const RENDER_QUALITIES: ReadonlyArray<RenderQuality> = ["auto", "low", "full"];

export function isRenderQuality(value: unknown): value is RenderQuality {
  return RENDER_QUALITIES.includes(value as RenderQuality);
}

/** The median GPU time of recent full-quality frames above which frames are slow (under 20 fps). */
export const SLOW_FRAME_MS = 50;
/** Bound page-owned calibration buffers before allocating a large working set. */
export const MAX_LOCAL_RENDER_BYTES = 256 * 1024 * 1024;

/** Execution location belongs to the plot session, independently of picture style. */
export class RenderExecution {
  private promoted = false;
  private slowDraws = 0;

  get useWorker(): boolean {
    return this.promoted;
  }

  recordWorkingSet(bytes: number): void {
    if (bytes > MAX_LOCAL_RENDER_BYTES) this.promoted = true;
  }

  /** Observe completed local draws, including preparation and GPU completion. */
  record(milliseconds: number): void {
    // The first expensive draw can include a one-time shader compilation.
    if (milliseconds > SLOW_FRAME_MS && ++this.slowDraws >= 2) this.promoted = true;
  }
}
/** The median below which slow frames count as fast again; the gap keeps the mode from flickering. */
export const FAST_FRAME_MS = 25;
/** Full-quality frames a verdict is based on; odd, so they have a middle one. */
export const MEASURED_FRAMES = 5;
/** Engage before the first software frame can stall the page. */
export const CONTINUOUS_ABOVE_ROWS = 6_000;
/** Keep already-fast hardware plots on their original GPU path. */
export const HARDWARE_CONTINUOUS_ABOVE_ROWS = 250_000;

/** The middle value of an odd number of values. */
function median(values: ReadonlyArray<number>): number {
  return Array.from(values).sort((a, b) => a - b)[(values.length - 1) / 2];
}

/** Decides from the GPU time of full-quality frames whether this machine draws them slowly. */
export class FramePerformance {
  private times: number[] = [];
  private isSlow = false;

  get slow(): boolean {
    return this.isSlow;
  }

  /** Records the GPU time of a full-quality frame; returns whether the verdict changed. */
  recordFullFrame(milliseconds: number): boolean {
    this.times.push(milliseconds);
    if (this.times.length > MEASURED_FRAMES) {
      this.times.shift();
    }
    if (this.times.length < MEASURED_FRAMES) {
      return false;
    }
    const typical = median(this.times);
    const slow = this.isSlow ? typical >= FAST_FRAME_MS : typical > SLOW_FRAME_MS;
    if (slow === this.isSlow) {
      return false;
    }
    this.isSlow = slow;
    // The next verdict rests on frames drawn under the new one.
    this.times = [];
    return true;
  }
}

/** Exact rendering remains an explicit override, regardless of size or timing. */
export function continuousRendering(
  quality: RenderQuality,
  slow: boolean,
  rows: number,
  software = true,
): boolean {
  const threshold = software ? CONTINUOUS_ABOVE_ROWS : HARDWARE_CONTINUOUS_ABOVE_ROWS;
  return quality === "low" || (quality === "auto" && (slow || rows > threshold));
}
