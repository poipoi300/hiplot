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
    const fit = fitColumn([...values, Number.NaN, Number.POSITIVE_INFINITY], "linear");
    expect(fit?.fitted).toBe(MAX_FIT_VALUES);
    expect(fit?.total).toBe(12_000);
    expect(fit?.best.label).toMatch(/\(/);
    expect(fit?.kde).not.toBeNull();
  });

  test("a constant column has no fit", () => {
    expect(fitColumn([1, 1, 1, 1], "linear")).toBeNull();
  });
});

describe("the KDE drawn on a log axis", () => {
  // Log-uniform over seven decades, 1e-5 to 1e2, like a learning rate sweep.
  const decades = 7;
  const values = Array.from({ length: 2000 }, (_, i) => 10 ** (decades * ((i + 0.5) / 2000) - 5));
  const valueAt = (position: number) => 10 ** (decades * position - 5);
  const binCount = 14;

  function kdeCurve(
    sample: ReadonlyArray<number>,
    spacing: "linear" | "log",
    steps: number,
  ): Array<[number, number]> {
    const kde = fitColumn(sample, spacing)?.kde;
    if (!kde) {
      throw new Error("No KDE");
    }
    return densityCurve((x) => kde.pdf(x), valueAt, binCount, steps);
  }

  test("smooths ln(x), so a log-uniform sample fills every decade evenly", () => {
    const inner = kdeCurve(values, "log", 280).filter(
      ([position]) => position > 0.1 && position < 0.9,
    );
    for (const [, share] of inner) {
      expect(share).toBeCloseTo(1 / binCount, 2);
    }
  });

  test("does not zigzag where the values are sparse in x", () => {
    // Direction changes of the curve over the top decade.
    const directionChanges = (curve: Array<[number, number]>) => {
      const top = curve
        .filter(([position]) => position > 1 - 1 / decades)
        .map(([, share]) => share);
      let changes = 0;
      for (let i = 2; i < top.length; ++i) {
        changes += (top[i] - top[i - 1]) * (top[i - 1] - top[i - 2]) < 0 ? 1 : 0;
      }
      return changes;
    };
    // A random log-uniform sample, drawn with a fixed seed (mulberry32).
    let seed = 7;
    const uniform = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sample = Array.from({ length: 2000 }, () => valueAt(uniform()));
    // The kernel of fixed width in x is the noisy curve this replaces; the
    // plot draws 160 steps.
    expect(directionChanges(kdeCurve(sample, "linear", 160))).toBeGreaterThan(5);
    expect(directionChanges(kdeCurve(sample, "log", 160))).toBeLessThanOrEqual(1);
  });

  test("is a density in x, in the histogram's units", () => {
    // Shares at the bin centers add up to the whole sample, as the bars do.
    const curve = kdeCurve(values, "log", 2 * binCount);
    const atBinCenters = curve.filter((_, step) => step % 2 === 1).map(([, share]) => share);
    expect(atBinCenters).toHaveLength(binCount);
    expect(atBinCenters.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 1);
    const kde = fitColumn(values, "log")?.kde;
    expect(kde?.pdf(0)).toBe(0);
    expect(kde?.pdf(-1)).toBe(0);
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
