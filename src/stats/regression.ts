/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Fits and summaries over whatever space the caller hands in: to fit in log
 * space, pass log10-transformed arrays. Rows with a non-finite value in any
 * input column are skipped.
 */

import { finiteColumns, isConstant, mean } from "./finite";
import { studentTQuantile } from "./special";

export interface LinearFit {
  slope: number;
  intercept: number;
  n: number;
  /** Share of y's variance explained; NaN when y is constant. */
  r2: number;
}

/** Ordinary least squares y = intercept + slope * x; null with fewer than two points or constant x. */
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>): LinearFit | null {
  const [pairedXs, pairedYs] = finiteColumns(xs, ys);
  if (pairedXs.length < 2 || isConstant(pairedXs)) {
    return null;
  }
  const xMean = mean(pairedXs);
  const yMean = mean(pairedYs);
  let crossSum = 0;
  let xSumSquares = 0;
  let ySumSquares = 0;
  for (let index = 0; index < pairedXs.length; ++index) {
    const xDeviation = pairedXs[index] - xMean;
    const yDeviation = pairedYs[index] - yMean;
    crossSum += xDeviation * yDeviation;
    xSumSquares += xDeviation * xDeviation;
    ySumSquares += yDeviation * yDeviation;
  }
  const slope = crossSum / xSumSquares;
  return {
    slope,
    intercept: yMean - slope * xMean,
    n: pairedXs.length,
    r2: isConstant(pairedYs)
      ? Number.NaN
      : Math.min(1, (crossSum * crossSum) / (xSumSquares * ySumSquares)),
  };
}

export interface BinnedMean {
  /** Mean x of the rows in the bin. */
  x: number;
  mean: number;
  n: number;
}

/**
 * Means of y in equal-width bins over the range of x. Empty bins are
 * omitted; the rest are sorted by x.
 */
export function binnedMeans(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  binCount: number,
): BinnedMean[] {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError(`binCount must be a positive integer, got ${binCount}`);
  }
  const [pairedXs, pairedYs] = finiteColumns(xs, ys);
  if (pairedXs.length === 0) {
    return [];
  }
  let lowest = pairedXs[0];
  let highest = pairedXs[0];
  for (const x of pairedXs) {
    lowest = Math.min(lowest, x);
    highest = Math.max(highest, x);
  }
  const binWidth = (highest - lowest) / binCount;
  const xSums = new Array<number>(binCount).fill(0);
  const ySums = new Array<number>(binCount).fill(0);
  const counts = new Array<number>(binCount).fill(0);
  for (let index = 0; index < pairedXs.length; ++index) {
    // The maximum lands on the upper edge of the last bin, so clamp into it.
    const bin =
      binWidth === 0
        ? 0
        : Math.min(binCount - 1, Math.floor((pairedXs[index] - lowest) / binWidth));
    xSums[bin] += pairedXs[index];
    ySums[bin] += pairedYs[index];
    counts[bin] += 1;
  }
  // Bins cover disjoint increasing ranges of x, so their mean x is already sorted.
  const means: BinnedMean[] = [];
  for (let bin = 0; bin < binCount; ++bin) {
    if (counts[bin] > 0) {
      means.push({ x: xSums[bin] / counts[bin], mean: ySums[bin] / counts[bin], n: counts[bin] });
    }
  }
  return means;
}

export interface CategoryMean {
  category: string;
  mean: number;
  /** Lower end of the 95% confidence interval of the mean; NaN when n = 1. */
  lower: number;
  /** Upper end of the 95% confidence interval of the mean; NaN when n = 1. */
  upper: number;
  n: number;
}

const CONFIDENCE_LEVEL_QUANTILE = 0.975;

/**
 * Mean of y per category with a 95% t confidence interval, in order of each
 * category's first appearance. Rows with a non-finite y are skipped, so a
 * category with no finite y is absent.
 */
export function categoryMeans(
  categories: ReadonlyArray<string>,
  ys: ArrayLike<number>,
): CategoryMean[] {
  if (categories.length !== ys.length) {
    throw new Error(
      `categories and ys must have equal length, got ${categories.length} and ${ys.length}`,
    );
  }
  const valuesByCategory = new Map<string, number[]>();
  for (let row = 0; row < categories.length; ++row) {
    if (!Number.isFinite(ys[row])) {
      continue;
    }
    const values = valuesByCategory.get(categories[row]);
    if (values === undefined) {
      valuesByCategory.set(categories[row], [ys[row]]);
    } else {
      values.push(ys[row]);
    }
  }
  return Array.from(valuesByCategory, ([category, values]) => {
    const n = values.length;
    const categoryMean = mean(values);
    if (n === 1) {
      return { category, mean: categoryMean, lower: Number.NaN, upper: Number.NaN, n };
    }
    let sumSquares = 0;
    for (const value of values) {
      sumSquares += (value - categoryMean) ** 2;
    }
    const halfWidth =
      (studentTQuantile(CONFIDENCE_LEVEL_QUANTILE, n - 1) * Math.sqrt(sumSquares / (n - 1))) /
      Math.sqrt(n);
    return {
      category,
      mean: categoryMean,
      lower: categoryMean - halfWidth,
      upper: categoryMean + halfWidth,
      n,
    };
  });
}

export interface PlaneFit {
  a: number;
  b: number;
  c: number;
  n: number;
  /** Share of z's variance explained; NaN when z is constant. */
  r2: number;
}

/** Relative determinant below which the x and y columns count as collinear. */
const COLLINEARITY_TOLERANCE = 1e-12;

/**
 * Least squares plane z = a + b * x + c * y. Centering on the means solves
 * the 3x3 normal equations through their 2x2 core. Null with fewer than
 * three points or when the points are collinear in (x, y).
 */
export function planeFit(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  zs: ArrayLike<number>,
): PlaneFit | null {
  const [pairedXs, pairedYs, pairedZs] = finiteColumns(xs, ys, zs);
  const n = pairedXs.length;
  if (n < 3) {
    return null;
  }
  const xMean = mean(pairedXs);
  const yMean = mean(pairedYs);
  const zMean = mean(pairedZs);
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xz = 0;
  let yz = 0;
  for (let index = 0; index < n; ++index) {
    const xDeviation = pairedXs[index] - xMean;
    const yDeviation = pairedYs[index] - yMean;
    const zDeviation = pairedZs[index] - zMean;
    xx += xDeviation * xDeviation;
    xy += xDeviation * yDeviation;
    yy += yDeviation * yDeviation;
    xz += xDeviation * zDeviation;
    yz += yDeviation * zDeviation;
  }
  const determinant = xx * yy - xy * xy;
  if (!(determinant > COLLINEARITY_TOLERANCE * xx * yy)) {
    return null;
  }
  const b = (yy * xz - xy * yz) / determinant;
  const c = (xx * yz - xy * xz) / determinant;
  const a = zMean - b * xMean - c * yMean;
  let residualSumSquares = 0;
  let totalSumSquares = 0;
  for (let index = 0; index < n; ++index) {
    residualSumSquares += (pairedZs[index] - (a + b * pairedXs[index] + c * pairedYs[index])) ** 2;
    totalSumSquares += (pairedZs[index] - zMean) ** 2;
  }
  return {
    a,
    b,
    c,
    n,
    r2: isConstant(pairedZs) ? Number.NaN : 1 - residualSumSquares / totalSumSquares,
  };
}
