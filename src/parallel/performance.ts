/*
 * Low-performance mode. Without a GPU, browsers draw WebGL in software, where
 * a frame costs what its pixels cost: line shape and anti-aliasing barely
 * change it, the number of pixels and lines drawn does. When full-quality
 * frames are slow, frames during a drag or a scroll are drawn at a fraction
 * of the resolution over a sample of the rows; the picture after the gesture
 * is drawn at full quality, and those frames keep measuring the machine.
 */

/** How frames during a gesture are drawn: decided from measured frames, or forced. */
export type RenderQuality = "auto" | "low" | "full";

export const RENDER_QUALITIES: ReadonlyArray<RenderQuality> = ["auto", "low", "full"];

export function isRenderQuality(value: unknown): value is RenderQuality {
  return RENDER_QUALITIES.includes(value as RenderQuality);
}

/** The median GPU time of recent full-quality frames above which frames are slow (under 20 fps). */
export const SLOW_FRAME_MS = 50;
/** The median below which slow frames count as fast again; the gap keeps the mode from flickering. */
export const FAST_FRAME_MS = 25;
/** Full-quality frames a verdict is based on; odd, so they have a middle one. */
export const MEASURED_FRAMES = 5;
/** Device resolution of low-performance frames, per axis: a quarter of the pixels. */
export const LOW_PERFORMANCE_RESOLUTION = 0.5;
/** Rows drawn by a low-performance frame, sampled from the shuffled draw order. */
export const LOW_PERFORMANCE_ROWS = 10_000;

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

/** Whether frames during a gesture are drawn in low-performance mode, for a quality setting. */
export function lowPerformance(quality: RenderQuality, slow: boolean): boolean {
  return quality === "low" || (quality === "auto" && slow);
}
