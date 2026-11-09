import { describe, expect, test } from "bun:test";
import {
  FAST_FRAME_MS,
  FramePerformance,
  isRenderQuality,
  lowPerformance,
  MEASURED_FRAMES,
  SLOW_FRAME_MS,
} from "./performance";

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
  test("auto follows the measurement; low and full force it", () => {
    expect(lowPerformance("auto", true)).toBe(true);
    expect(lowPerformance("auto", false)).toBe(false);
    expect(lowPerformance("low", false)).toBe(true);
    expect(lowPerformance("full", true)).toBe(false);
  });

  test("only the three settings are accepted from saved state", () => {
    expect(isRenderQuality("auto")).toBe(true);
    expect(isRenderQuality("full")).toBe(true);
    expect(isRenderQuality("fast")).toBe(false);
    expect(isRenderQuality(1)).toBe(false);
  });
});
