/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  type FittedDistribution,
  fitDistributions,
  type KernelDensity,
  kernelDensity,
} from "../stats/distributions";

/**
 * Fitting is linear or worse in the values (the Student t search dominates),
 * so beyond this many values an evenly spaced sample is fitted: the choice
 * between candidates and their parameters barely move, and a selection of
 * 100,000 rows still fits in a few milliseconds.
 */
export const MAX_FIT_VALUES = 5000;

/** The fit of one column's values: the best candidate, the runner-up and a KDE reference. */
export interface ColumnFit {
  best: FittedDistribution;
  runnerUp: FittedDistribution | null;
  kde: KernelDensity | null;
  /** Values fitted, and values the column had (more when a sample was fitted). */
  fitted: number;
  total: number;
}

/** At most `max` of `values`, evenly spaced through them, in their order. */
export function evenSample(values: ReadonlyArray<number>, max: number): number[] {
  if (values.length <= max) {
    return [...values];
  }
  const step = values.length / max;
  return Array.from({ length: max }, (_, index) => values[Math.floor(index * step)]);
}

/** The best distribution for `values` by BIC, with a KDE to compare it to; null when none fits. */
export function fitColumn(values: ReadonlyArray<number>): ColumnFit | null {
  const finite = values.filter(Number.isFinite);
  const sample = evenSample(finite, MAX_FIT_VALUES);
  const fits = fitDistributions(sample);
  if (fits.best === null) {
    return null;
  }
  return {
    best: fits.best,
    runnerUp: fits.candidates[1] ?? null,
    kde: kernelDensity(sample),
    fitted: sample.length,
    total: finite.length,
  };
}

/** Step in axis position of the numerical derivative of value by position. */
const DERIVATIVE_STEP = 1e-4;

/**
 * A density drawn over a histogram whose bins are equal in axis position:
 * at each position p in [0, 1], the share of rows a bin of width
 * `1 / binCount` around p holds, pdf(x(p)) · |dx/dp| / binCount. The
 * derivative is taken numerically, so linear, log and percentile axes all
 * work; positions with no finite value are left out.
 */
export function densityCurve(
  pdf: (x: number) => number,
  valueAt: (position: number) => number,
  binCount: number,
  steps: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let step = 0; step <= steps; ++step) {
    const position = step / steps;
    const x = valueAt(position);
    const after = Math.min(1, position + DERIVATIVE_STEP);
    const before = Math.max(0, position - DERIVATIVE_STEP);
    const span = Math.abs(valueAt(after) - valueAt(before));
    const width = after - before;
    const share = (pdf(x) * (span / width)) / binCount;
    if (Number.isFinite(share)) {
      points.push([position, share]);
    }
  }
  return points;
}
