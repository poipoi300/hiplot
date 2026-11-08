import { describe, expect, test } from "bun:test";
import { correlationSummary, pearson, spearman } from "./correlation";

const XS = [1, 2, 3, 4, 5];
const YS = [2, 4, 5, 4, 5];

describe("pearson", () => {
  test("a perfect rising line is 1 and a falling line is -1", () => {
    expect(
      pearson(
        XS,
        XS.map((x) => 3 * x + 7),
      ),
    ).toBeCloseTo(1, 14);
    expect(
      pearson(
        XS,
        XS.map((x) => -0.5 * x),
      ),
    ).toBeCloseTo(-1, 14);
  });

  test("a small dataset matches the hand-computed value sqrt(0.6)", () => {
    // Sxy = 6, Sxx = 10, Syy = 6.
    expect(pearson(XS, YS)).toBeCloseTo(Math.sqrt(0.6), 14);
  });

  test("it never exceeds 1 despite rounding", () => {
    const xs = Array.from({ length: 1000 }, (_, index) => index * 0.1);
    expect(
      pearson(
        xs,
        xs.map((x) => 0.3 * x + 0.1),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("fewer than two pairs give NaN", () => {
    expect(pearson([], [])).toBeNaN();
    expect(pearson([1], [2])).toBeNaN();
  });

  test("a constant column gives NaN even when rounding would leave residual variance", () => {
    expect(pearson([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], [1, 2, 3, 4, 5, 6, 7])).toBeNaN();
    expect(pearson([1, 2, 3], [4, 4, 4])).toBeNaN();
  });

  test("a non-finite entry gives NaN", () => {
    expect(pearson([1, 2, Number.NaN], [1, 2, 3])).toBeNaN();
  });

  test("unequal lengths throw", () => {
    expect(() => pearson([1, 2], [1, 2, 3])).toThrow();
  });

  test("typed arrays are accepted", () => {
    expect(pearson(Float64Array.from(XS), Float64Array.from(XS))).toBeCloseTo(1, 14);
  });
});

describe("spearman", () => {
  test("a monotone nonlinear relation is exactly 1", () => {
    expect(
      spearman(
        XS,
        XS.map((x) => Math.exp(x)),
      ),
    ).toBeCloseTo(1, 14);
    expect(
      spearman(
        XS,
        XS.map((x) => -(x ** 3)),
      ),
    ).toBeCloseTo(-1, 14);
  });

  test("ties share the mean rank", () => {
    // y ranks are [1, 2.5, 4.5, 2.5, 4.5]: Sxy = 7, Sxx = 10, Syy = 9.
    expect(spearman(XS, YS)).toBeCloseTo(7 / Math.sqrt(90), 14);
  });

  test("it resists an outlier that drags Pearson down", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const ys = [1, 2, 3, 4, 5, 1000];
    expect(spearman(xs, ys)).toBeCloseTo(1, 14);
    expect(pearson(xs, ys)).toBeLessThan(0.8);
  });

  test("all-tied or non-finite input gives NaN", () => {
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNaN();
    expect(spearman([1, Number.NaN, 3], [1, 2, 3])).toBeNaN();
  });

  test("unequal lengths throw", () => {
    expect(() => spearman([1], [1, 2])).toThrow();
  });
});

describe("correlationSummary", () => {
  test("it reports both coefficients and the pair count", () => {
    const summary = correlationSummary(XS, YS);
    expect(summary.n).toBe(5);
    expect(summary.pearson).toBeCloseTo(Math.sqrt(0.6), 14);
    expect(summary.spearman).toBeCloseTo(7 / Math.sqrt(90), 14);
  });

  test("only pairs where both values are finite are used", () => {
    const summary = correlationSummary(
      [1, 2, Number.NaN, 3, 4, 5, Number.POSITIVE_INFINITY],
      [10, 20, 30, 30, 40, 50, 60],
    );
    expect(summary.n).toBe(5);
    expect(summary.pearson).toBeCloseTo(1, 14);
    expect(summary.spearman).toBeCloseTo(1, 14);
  });

  test("an empty selection has no correlation", () => {
    const summary = correlationSummary([], []);
    expect(summary.n).toBe(0);
    expect(summary.pearson).toBeNaN();
    expect(summary.spearman).toBeNaN();
  });

  test("unequal lengths throw", () => {
    expect(() => correlationSummary([1, 2], [1])).toThrow();
  });
});
