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
  /** In the units of x; its bandwidth is in ln(x) on a log axis. */
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

/** How the axis a density is drawn on spaces its values. */
export type AxisSpacing = "linear" | "log";

/**
 * A Gaussian KDE of ln(x), as a density in x: g(ln x) / x, the Jacobian of
 * the log. On a log axis a kernel of fixed width in x is far too narrow where
 * values are sparse in x (the upper decades) and too wide where they crowd;
 * in ln(x) its bandwidth follows the axis. Values that are not positive have
 * no place on a log axis and are left out, as the histogram leaves them out.
 */
function logKernelDensity(sample: ReadonlyArray<number>): KernelDensity | null {
  const density = kernelDensity(sample.filter((value) => value > 0).map(Math.log));
  if (density === null) {
    return null;
  }
  return {
    bandwidth: density.bandwidth,
    pdf: (x) => (x > 0 ? density.pdf(Math.log(x)) / x : 0),
  };
}

/**
 * The best distribution for `values` by BIC, with a KDE to compare it to;
 * null when none fits. The KDE smooths in the axis' spacing (see
 * `logKernelDensity`); the candidates' own families cover log-scale data.
 */
export function fitColumn(values: ReadonlyArray<number>, spacing: AxisSpacing): ColumnFit | null {
  const finite = values.filter(Number.isFinite);
  const sample = evenSample(finite, MAX_FIT_VALUES);
  const fits = fitDistributions(sample);
  if (fits.best === null) {
    return null;
  }
  return {
    best: fits.best,
    runnerUp: fits.candidates[1] ?? null,
    kde: spacing === "log" ? logKernelDensity(sample) : kernelDensity(sample),
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
