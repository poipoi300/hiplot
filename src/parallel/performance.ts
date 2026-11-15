/* Which picture the parallel plot draws, and when gestures draft it. On a GPU,
 * exact lines draw any number of rows; continuous density is the software
 * rasterizer's picture, engaged before expensive initial frames or after
 * measured slow frames, and the persisted "low" choice.
 */

/** How lines are drawn: automatically, as continuous density ("low"), or as exact lines ("full"). */
export type RenderQuality = "auto" | "low" | "full";

export const RENDER_QUALITIES: ReadonlyArray<RenderQuality> = ["auto", "low", "full"];

export function isRenderQuality(value: unknown): value is RenderQuality {
  return RENDER_QUALITIES.includes(value as RenderQuality);
}

/** The median GPU time of recent full-quality frames above which frames are slow (under 20 fps). */
export const SLOW_FRAME_MS = 50;
/**
 * Whether gesture frames draft. Two full frames of every row in a row taking
 * longer than SLOW_FRAME_MS turn drafts on, as a gesture's frames would take as
 * long: one slow frame may only be a one-time cost such as compiling shaders.
 * A full frame under FAST_FRAME_MS turns them off; frames in between keep the
 * current choice, so frames near the limit do not alternate within a gesture.
 */
export class DraftPolicy {
  private slowInARow = 0;
  private on = false;

  get drafting(): boolean {
    return this.on;
  }

  /** Observe a full frame of every row, timed in its renderer from submission to GPU completion. */
  record(milliseconds: number): void {
    if (milliseconds > SLOW_FRAME_MS) {
      this.slowInARow += 1;
      if (this.slowInARow >= 2) this.on = true;
      return;
    }
    this.slowInARow = 0;
    if (milliseconds < FAST_FRAME_MS) this.on = false;
  }
}
/** The median below which slow frames count as fast again; the gap keeps the mode from flickering. */
export const FAST_FRAME_MS = 25;
/** Full-quality frames a verdict is based on; odd, so they have a middle one. */
export const MEASURED_FRAMES = 5;
/** Engage before the first software frame can stall the page. */
export const CONTINUOUS_ABOVE_ROWS = 6_000;

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

/**
 * Whether lines draw as continuous density: when chosen, or automatically on a
 * software rasterizer with many rows or slow frames. A GPU draws exact lines at
 * any size: brushing sums retained blocks (see LineFocus in webgl.ts).
 */
export function continuousRendering(
  quality: RenderQuality,
  slow: boolean,
  rows: number,
  software: boolean,
): boolean {
  return (
    quality === "low" || (quality === "auto" && software && (slow || rows > CONTINUOUS_ABOVE_ROWS))
  );
}
