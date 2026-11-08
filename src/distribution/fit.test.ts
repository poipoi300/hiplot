import { describe, expect, test } from "bun:test";
import { densityCurve, evenSample, fitColumn, MAX_FIT_VALUES } from "./fit";

describe("fitting a column", () => {
  test("large columns are fitted on an evenly spaced sample", () => {
    const values = Array.from({ length: 20_000 }, (_, i) => i);
    const sample = evenSample(values, 4);
    expect(sample).toEqual([0, 5000, 10000, 15000]);
    expect(evenSample([3, 1, 2], 10)).toEqual([3, 1, 2]);
  });

  test("the fit says how many values it used, skipping non-finite ones", () => {
    const values = Array.from({ length: 12_000 }, (_, i) => Math.sin(i) * 3 + 10);
    const fit = fitColumn([...values, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(fit?.fitted).toBe(MAX_FIT_VALUES);
    expect(fit?.total).toBe(12_000);
    expect(fit?.best.label).toMatch(/\(/);
    expect(fit?.kde).not.toBeNull();
  });

  test("a constant column has no fit", () => {
    expect(fitColumn([1, 1, 1, 1])).toBeNull();
  });
});

describe("drawing a density over a histogram", () => {
  test("a uniform density over a linear axis fills each bin equally", () => {
    const curve = densityCurve(
      (x) => (x >= 0 && x <= 2 ? 0.5 : 0),
      (position) => 2 * position,
      10,
      20,
    );
    for (const [, share] of curve) {
      expect(share).toBeCloseTo(0.1, 6);
    }
  });

  test("on a log axis the share follows the density per decade", () => {
    // Log-uniform over 1..100: equal shares per equal step in log position.
    const curve = densityCurve(
      (x) => 1 / (x * Math.log(100)),
      (position) => 10 ** (2 * position),
      4,
      40,
    );
    for (const [, share] of curve) {
      expect(share).toBeCloseTo(0.25, 2);
    }
  });
});
