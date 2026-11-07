import { describe, expect, test } from "bun:test";
import { monotoneSlope, SPLINE_HANDLE, splineParameter, splineY } from "./spline";

describe("monotone slopes", () => {
  test("a line that keeps rising flows through the axis", () => {
    expect(monotoneSlope(0, 0, 100, 50, 200, 100)).toBeCloseTo(0.5);
  });

  test("a line that turns at an axis is level there", () => {
    expect(monotoneSlope(0, 0, 100, 50, 200, 0)).toBe(0);
  });

  test("a steep neighbor never makes the line overshoot the gentle side", () => {
    const slope = monotoneSlope(0, 0, 100, 10, 200, 210);
    expect(slope).toBeGreaterThan(0);
    for (let step = 0; step <= 20; ++step) {
      const y = splineY(step / 20, 100, 0, 0, 10, slope);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(10);
    }
  });

  test("a missing neighbor or a collapsed gap levels the line", () => {
    expect(monotoneSlope(Number.NaN, Number.NaN, 100, 50, 200, 100)).toBe(0);
    expect(monotoneSlope(0, 0, 100, 50, 200, Number.NaN)).toBe(0);
    expect(monotoneSlope(100, 0, 100, 50, 200, 100)).toBe(0);
  });
});

describe("spline segments", () => {
  test("the parameter maps the ends and the middle of the gap onto themselves", () => {
    expect(splineParameter(0)).toBeCloseTo(0, 5);
    expect(splineParameter(0.5)).toBeCloseTo(0.5, 5);
    expect(splineParameter(1)).toBeCloseTo(1, 5);
    expect(splineParameter(-3)).toBeCloseTo(0, 5);
  });

  test("a level segment is an S curve that stays near each axis longer than a straight line", () => {
    const t = splineParameter(0.2);
    const y = splineY(t, 100, 0, 0, 100, 0);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(20);
    expect(splineY(splineParameter(0.5), 100, 0, 0, 100, 0)).toBeCloseTo(50, 3);
  });

  test("handles follow the slope at each end", () => {
    const rising = splineY(splineParameter(0.1), 100, 0, 1, 100, 1);
    const level = splineY(splineParameter(0.1), 100, 0, 0, 100, 0);
    expect(rising).toBeGreaterThan(level);
    expect(SPLINE_HANDLE).toBe(0.5);
  });
});
