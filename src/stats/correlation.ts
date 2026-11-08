/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { allFinite, finiteColumns, isConstant, mean } from "./finite";

function assertEqualLength(xs: ArrayLike<number>, ys: ArrayLike<number>): void {
  if (xs.length !== ys.length) {
    throw new Error(`xs and ys must have equal length, got ${xs.length} and ${ys.length}`);
  }
}

/**
 * Pearson product-moment correlation, in [-1, 1]. NaN when there are fewer
 * than two pairs, either side is constant, or any entry is not finite.
 */
export function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  assertEqualLength(xs, ys);
  if (xs.length < 2 || isConstant(xs) || isConstant(ys)) {
    return Number.NaN;
  }
  const xValues = Array.from(xs);
  const yValues = Array.from(ys);
  const xMean = mean(xValues);
  const yMean = mean(yValues);
  let crossSum = 0;
  let xSumSquares = 0;
  let ySumSquares = 0;
  for (let index = 0; index < xValues.length; ++index) {
    const xDeviation = xValues[index] - xMean;
    const yDeviation = yValues[index] - yMean;
    crossSum += xDeviation * yDeviation;
    xSumSquares += xDeviation * xDeviation;
    ySumSquares += yDeviation * yDeviation;
  }
  const correlation = crossSum / (Math.sqrt(xSumSquares) * Math.sqrt(ySumSquares));
  // Rounding can push a perfect line a few ulps past +-1.
  return Math.max(-1, Math.min(1, correlation));
}

/** 1-based ranks of `values`; tied values share the mean of the ranks they span. */
function averageRanks(values: ReadonlyArray<number>): number[] {
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(values.length);
  let groupStart = 0;
  while (groupStart < order.length) {
    let groupEnd = groupStart;
    while (
      groupEnd + 1 < order.length &&
      values[order[groupEnd + 1]] === values[order[groupStart]]
    ) {
      ++groupEnd;
    }
    const sharedRank = (groupStart + groupEnd) / 2 + 1;
    for (let position = groupStart; position <= groupEnd; ++position) {
      ranks[order[position]] = sharedRank;
    }
    groupStart = groupEnd + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation: Pearson of the average ranks. NaN under the
 * same conditions as `pearson`.
 */
export function spearman(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  assertEqualLength(xs, ys);
  if (!allFinite(xs) || !allFinite(ys)) {
    return Number.NaN;
  }
  return pearson(averageRanks(Array.from(xs)), averageRanks(Array.from(ys)));
}

export interface CorrelationSummary {
  /** Pairs where both values are finite. */
  n: number;
  pearson: number;
  spearman: number;
}

/**
 * Both correlations over the index pairs where x and y are finite numbers.
 * Correlate log-transformed arrays to correlate in log space.
 */
export function correlationSummary(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): CorrelationSummary {
  const [pairedXs, pairedYs] = finiteColumns(xs, ys);
  return {
    n: pairedXs.length,
    pearson: pearson(pairedXs, pairedYs),
    spearman: spearman(pairedXs, pairedYs),
  };
}
