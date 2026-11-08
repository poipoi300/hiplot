import { describe, expect, test } from "bun:test";
import { binnedMeans, categoryMeans, linearFit, planeFit } from "./regression";
import { studentTQuantile } from "./special";

describe("linearFit", () => {
  test("exact data recovers slope, intercept and a perfect r2", () => {
    const xs = [-2, 0, 1, 4, 9];
    const fit = linearFit(
      xs,
      xs.map((x) => 2.5 * x - 4),
    );
    expect(fit?.slope).toBeCloseTo(2.5, 12);
    expect(fit?.intercept).toBeCloseTo(-4, 12);
    expect(fit?.n).toBe(5);
    expect(fit?.r2).toBeCloseTo(1, 12);
  });

  test("noisy data matches the hand-computed least squares line", () => {
    // Sxy = 6, Sxx = 10, Syy = 6, means 3 and 4.
    const fit = linearFit([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    expect(fit?.slope).toBeCloseTo(0.6, 12);
    expect(fit?.intercept).toBeCloseTo(2.2, 12);
    expect(fit?.r2).toBeCloseTo(0.6, 12);
  });

  test("rows with a non-finite value are skipped", () => {
    const fit = linearFit([0, 1, Number.NaN, 2, 3], [1, 3, 99, 5, Number.POSITIVE_INFINITY]);
    expect(fit?.n).toBe(3);
    expect(fit?.slope).toBeCloseTo(2, 12);
    expect(fit?.intercept).toBeCloseTo(1, 12);
  });

  test("a constant y fits a flat line with an undefined r2", () => {
    const fit = linearFit([1, 2, 3], [7, 7, 7]);
    expect(fit?.slope).toBeCloseTo(0, 12);
    expect(fit?.intercept).toBeCloseTo(7, 12);
    expect(fit?.r2).toBeNaN();
  });

  test("fewer than two points or a constant x has no fit", () => {
    expect(linearFit([1], [2])).toBeNull();
    expect(linearFit([Number.NaN, 1], [1, Number.NaN])).toBeNull();
    expect(linearFit([0.1, 0.1, 0.1], [1, 2, 3])).toBeNull();
  });

  test("unequal lengths throw", () => {
    expect(() => linearFit([1, 2], [1])).toThrow();
  });
});

describe("binnedMeans", () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const ys = xs.map((x) => 2 * x);

  test("equal-width bins report the mean x, mean y and count", () => {
    const bins = binnedMeans(xs, ys, 2);
    expect(bins).toEqual([
      { x: 2, mean: 4, n: 5 },
      { x: 7, mean: 14, n: 5 },
    ]);
  });

  test("the maximum falls into the last bin", () => {
    const bins = binnedMeans(xs, ys, 3);
    expect(bins.map((bin) => bin.n)).toEqual([3, 3, 4]);
    expect(bins[2].x).toBeCloseTo(7.5, 12);
  });

  test("empty bins are omitted and the rest stay sorted by x", () => {
    const bins = binnedMeans([10, 0, 9, 1], [100, 0, 90, 10], 5);
    expect(bins).toEqual([
      { x: 0.5, mean: 5, n: 2 },
      { x: 9.5, mean: 95, n: 2 },
    ]);
  });

  test("a single distinct x collapses to one bin", () => {
    expect(binnedMeans([3, 3, 3], [1, 2, 6], 4)).toEqual([{ x: 3, mean: 3, n: 3 }]);
  });

  test("non-finite rows are skipped and no data gives no bins", () => {
    expect(binnedMeans([Number.NaN, 1, 2], [1, Number.NaN, 4], 2)).toEqual([
      { x: 2, mean: 4, n: 1 },
    ]);
    expect(binnedMeans([], [], 3)).toEqual([]);
  });

  test("a non-positive or fractional bin count throws", () => {
    expect(() => binnedMeans(xs, ys, 0)).toThrow(RangeError);
    expect(() => binnedMeans(xs, ys, 2.5)).toThrow(RangeError);
  });
});

describe("categoryMeans", () => {
  test("the confidence interval is mean +- t(0.975, n-1) s / sqrt(n)", () => {
    const [group] = categoryMeans(["a", "a", "a", "a", "a"], [1, 2, 3, 4, 5]);
    const halfWidth = studentTQuantile(0.975, 4) * Math.sqrt(2.5 / 5);
    expect(group.category).toBe("a");
    expect(group.n).toBe(5);
    expect(group.mean).toBe(3);
    expect(halfWidth).toBeCloseTo(2.7764451052 * Math.sqrt(0.5), 8);
    expect(group.lower).toBeCloseTo(3 - halfWidth, 12);
    expect(group.upper).toBeCloseTo(3 + halfWidth, 12);
  });

  test("a single row has a mean but no interval", () => {
    const [group] = categoryMeans(["solo"], [4]);
    expect(group.mean).toBe(4);
    expect(group.n).toBe(1);
    expect(group.lower).toBeNaN();
    expect(group.upper).toBeNaN();
  });

  test("categories keep the order of their first appearance", () => {
    const groups = categoryMeans(["b", "a", "b", "c", "a"], [1, 2, 3, 4, 6]);
    expect(groups.map((group) => group.category)).toEqual(["b", "a", "c"]);
    expect(groups.map((group) => group.mean)).toEqual([2, 4, 4]);
  });

  test("rows with a non-finite y are skipped, dropping categories left empty", () => {
    const groups = categoryMeans(["a", "a", "b", "a"], [1, Number.NaN, Number.NaN, 3]);
    expect(groups.map((group) => [group.category, group.mean, group.n])).toEqual([["a", 2, 2]]);
  });

  test("identical values give a zero-width interval", () => {
    const [group] = categoryMeans(["a", "a", "a"], [5, 5, 5]);
    expect(group.lower).toBe(5);
    expect(group.upper).toBe(5);
  });

  test("unequal lengths throw", () => {
    expect(() => categoryMeans(["a"], [1, 2])).toThrow();
  });
});

describe("planeFit", () => {
  const gridXs = [0, 1, 2, 0, 1, 2, 0, 1, 2];
  const gridYs = [0, 0, 0, 1, 1, 1, 2, 2, 2];

  test("an exact plane is recovered with a perfect r2", () => {
    const zs = gridXs.map((x, index) => 1 + 2 * x - 3 * gridYs[index]);
    const fit = planeFit(gridXs, gridYs, zs);
    expect(fit?.a).toBeCloseTo(1, 12);
    expect(fit?.b).toBeCloseTo(2, 12);
    expect(fit?.c).toBeCloseTo(-3, 12);
    expect(fit?.n).toBe(9);
    expect(fit?.r2).toBeCloseTo(1, 12);
  });

  test("an imperfect plane matches the hand-computed least squares fit", () => {
    // Residuals are [.25, -.25, -.25, .25] over Szz = .75, so r2 = 2/3.
    const fit = planeFit([0, 1, 0, 1], [0, 0, 1, 1], [0, 0, 0, 1]);
    expect(fit?.a).toBeCloseTo(-0.25, 12);
    expect(fit?.b).toBeCloseTo(0.5, 12);
    expect(fit?.c).toBeCloseTo(0.5, 12);
    expect(fit?.r2).toBeCloseTo(2 / 3, 12);
  });

  test("rows with a non-finite value are skipped", () => {
    const zs = gridXs.map((x, index) => 5 + x + gridYs[index]);
    zs[4] = Number.NaN;
    expect(planeFit(gridXs, gridYs, zs)?.n).toBe(8);
  });

  test("collinear or too few points have no plane", () => {
    expect(planeFit([0, 1, 2, 3], [0, 1, 2, 3], [1, 2, 3, 4])).toBeNull();
    expect(planeFit([0, 1, 2, 3], [5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
    expect(planeFit([0, 1], [0, 1], [0, 1])).toBeNull();
  });

  test("a constant z fits a flat plane with an undefined r2", () => {
    const fit = planeFit(
      gridXs,
      gridYs,
      gridXs.map(() => 4),
    );
    expect(fit?.a).toBeCloseTo(4, 12);
    expect(fit?.b).toBeCloseTo(0, 12);
    expect(fit?.r2).toBeNaN();
  });

  test("unequal lengths throw", () => {
    expect(() => planeFit([1, 2, 3], [1, 2, 3], [1, 2])).toThrow();
  });
});
