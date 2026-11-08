/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { type CorrelationSummary, correlationSummary } from "../stats/correlation";
import { binnedMeans, categoryMeans, linearFit } from "../stats/regression";
import { type Datapoint, type DatapointValue, ParamType } from "../types";

/** How a scatter of two numeric columns summarizes y against x. */
export type FitMode = "linear" | "binned";
export const isFitMode = (value: unknown): value is FitMode =>
  value === "linear" || value === "binned";

/** One axis of a scatter: its column and the type its scale was built for. */
export interface StatsAxis {
  column: string;
  type: ParamType;
}

/** Bins of the binned-means curve. */
const MEAN_BINS = 12;
/** Points the straight fit is sampled at, so it bends correctly on any axis scale. */
const LINE_POINTS = 48;

export type ScatterStats =
  | {
      kind: "numeric";
      summary: CorrelationSummary;
      /** Log axes are fitted in log space (log10 of the values). */
      logX: boolean;
      logY: boolean;
      fit:
        | {
            mode: "linear";
            slope: number;
            intercept: number;
            r2: number;
            points: [number, number][];
          }
        | { mode: "binned"; points: [number, number][] }
        | null;
    }
  | {
      kind: "categorical";
      /** The axis the categories are on; means are of the other one. */
      categoriesOn: "x" | "y";
      logged: boolean;
      n: number;
      means: Array<{ category: string; mean: number; lower: number; upper: number; n: number }>;
    }
  | { kind: "none"; reason: string };

/** A row's value in the space fits are made in: log10 on log axes; NaN when not a usable number. */
export function fitSpaceValue(value: DatapointValue, type: ParamType): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.NaN;
  }
  if (type === ParamType.NUMERICLOG) {
    return value > 0 ? Math.log10(value) : Number.NaN;
  }
  return value;
}

/** A value back from fit space. */
export function fromFitSpace(value: number, type: ParamType): number {
  return type === ParamType.NUMERICLOG ? 10 ** value : value;
}

const isCategorical = (type: ParamType) => type === ParamType.CATEGORICAL;

/**
 * Correlations and a fit of the rows' y against x: for two numeric columns,
 * Pearson r, Spearman ρ and a straight fit or binned means; for a category
 * and a number, the number's mean per category with a 95% interval. Log
 * axes are fitted in log space, and fits come back as data values.
 */
export function scatterStats(
  rows: ReadonlyArray<Datapoint>,
  x: StatsAxis,
  y: StatsAxis,
  mode: FitMode,
): ScatterStats {
  if (isCategorical(x.type) && isCategorical(y.type)) {
    return { kind: "none", reason: "No fit between two categorical columns" };
  }
  if (isCategorical(x.type) || isCategorical(y.type)) {
    const [categoryAxis, valueAxis] = isCategorical(x.type) ? [x, y] : [y, x];
    const categories: string[] = [];
    const values: number[] = [];
    for (const row of rows) {
      const category = row[categoryAxis.column];
      const value = fitSpaceValue(row[valueAxis.column], valueAxis.type);
      if (category !== undefined && Number.isFinite(value)) {
        categories.push(String(category));
        values.push(value);
      }
    }
    const back = (value: number) => fromFitSpace(value, valueAxis.type);
    return {
      kind: "categorical",
      categoriesOn: categoryAxis === x ? "x" : "y",
      logged: valueAxis.type === ParamType.NUMERICLOG,
      n: values.length,
      means: categoryMeans(categories, values).map((mean) => ({
        ...mean,
        mean: back(mean.mean),
        lower: back(mean.lower),
        upper: back(mean.upper),
      })),
    };
  }
  const us = rows.map((row) => fitSpaceValue(row[x.column], x.type));
  const vs = rows.map((row) => fitSpaceValue(row[y.column], y.type));
  const summary = correlationSummary(us, vs);
  const logX = x.type === ParamType.NUMERICLOG;
  const logY = y.type === ParamType.NUMERICLOG;
  const toData = (u: number, v: number): [number, number] => [
    fromFitSpace(u, x.type),
    fromFitSpace(v, y.type),
  ];
  if (mode === "binned") {
    const bins = binnedMeans(us, vs, MEAN_BINS);
    return {
      kind: "numeric",
      summary,
      logX,
      logY,
      fit: bins.length === 0 ? null : { mode, points: bins.map((bin) => toData(bin.x, bin.mean)) },
    };
  }
  const line = linearFit(us, vs);
  if (line === null) {
    return { kind: "numeric", summary, logX, logY, fit: null };
  }
  const finite = us.filter(Number.isFinite);
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const points = Array.from({ length: LINE_POINTS }, (_, index) => {
    const u = low + ((high - low) * index) / (LINE_POINTS - 1);
    return toData(u, line.intercept + line.slope * u);
  });
  return {
    kind: "numeric",
    summary,
    logX,
    logY,
    fit: { mode, slope: line.slope, intercept: line.intercept, r2: line.r2, points },
  };
}
