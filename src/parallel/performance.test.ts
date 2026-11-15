import { describe, expect, test } from "bun:test";
import {
  CONTINUOUS_ABOVE_ROWS,
  continuousRendering,
  DraftPolicy,
  FAST_FRAME_MS,
  FramePerformance,
  isRenderQuality,
  MEASURED_FRAMES,
  SLOW_FRAME_MS,
} from "./performance";

describe("gesture drafts", () => {
  test("start after two slow full frames in a row, not after one-time costs", () => {
    const drafts = new DraftPolicy();
    drafts.record(SLOW_FRAME_MS + 1);
    expect(drafts.drafting).toBe(false);
    drafts.record(8);
    drafts.record(SLOW_FRAME_MS + 1);
    expect(drafts.drafting).toBe(false);
    drafts.record(SLOW_FRAME_MS + 1);
    expect(drafts.drafting).toBe(true);
  });

  test("stop only once a full frame is fast, so frames near the limit do not alternate", () => {
    const drafts = new DraftPolicy();
    drafts.record(SLOW_FRAME_MS + 1);
    drafts.record(SLOW_FRAME_MS + 1);
    drafts.record(SLOW_FRAME_MS - 1);
    expect(drafts.drafting).toBe(true);
    drafts.record(FAST_FRAME_MS);
    expect(drafts.drafting).toBe(true);
    drafts.record(FAST_FRAME_MS - 1);
    expect(drafts.drafting).toBe(false);
  });
});

function record(performance: FramePerformance, milliseconds: number, count: number): boolean[] {
  return Array.from({ length: count }, () => performance.recordFullFrame(milliseconds));
}

describe("detecting slow frames", () => {
  test("a machine counts as slow once the median of recent frames exceeds the limit", () => {
    const performance = new FramePerformance();
    expect(record(performance, SLOW_FRAME_MS + 1, MEASURED_FRAMES - 1)).not.toContain(true);
    expect(performance.slow).toBe(false);
    expect(performance.recordFullFrame(SLOW_FRAME_MS + 1)).toBe(true);
    expect(performance.slow).toBe(true);
  });

  test("one slow frame among fast ones changes nothing", () => {
    const performance = new FramePerformance();
    record(performance, 10, MEASURED_FRAMES - 1);
    expect(performance.recordFullFrame(500)).toBe(false);
    expect(performance.slow).toBe(false);
  });

  test("a slow machine counts as fast again only well under the limit", () => {
    const performance = new FramePerformance();
    record(performance, 200, MEASURED_FRAMES);
    expect(record(performance, (SLOW_FRAME_MS + FAST_FRAME_MS) / 2, MEASURED_FRAMES)).not.toContain(
      true,
    );
    expect(performance.slow).toBe(true);
    record(performance, FAST_FRAME_MS - 1, MEASURED_FRAMES);
    expect(performance.slow).toBe(false);
  });

  test("the verdict follows the middle frame, not the extremes", () => {
    const performance = new FramePerformance();
    for (const milliseconds of [10, 20, 60, 70, 900]) {
      performance.recordFullFrame(milliseconds);
    }
    expect(performance.slow).toBe(true);
  });
});

describe("render quality settings", () => {
  test("a GPU draws exact lines at any size or speed unless density is chosen", () => {
    expect(continuousRendering("auto", true, 10_000_000, false)).toBe(false);
    expect(continuousRendering("low", false, 100, false)).toBe(true);
    expect(continuousRendering("full", true, 10_000_000, false)).toBe(false);
  });

  test("a software rasterizer draws density above a few thousand rows or once slow", () => {
    expect(continuousRendering("auto", false, CONTINUOUS_ABOVE_ROWS, true)).toBe(false);
    expect(continuousRendering("auto", false, CONTINUOUS_ABOVE_ROWS + 1, true)).toBe(true);
    expect(continuousRendering("auto", true, 100, true)).toBe(true);
    expect(continuousRendering("full", true, 1_000_000, true)).toBe(false);
  });

  test("only the three settings are accepted from saved state", () => {
    expect(isRenderQuality("auto")).toBe(true);
    expect(isRenderQuality("full")).toBe(true);
    expect(isRenderQuality("fast")).toBe(false);
    expect(isRenderQuality(1)).toBe(false);
  });
});
