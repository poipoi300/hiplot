/*
 * Default axis orientation that follows the color gradient: every axis puts the
 * values that come with high colors at its top, so a line keeps the same height
 * across axes the color says it should, and both ends of the gradient are easy
 * to follow.
 */

import { create_d3_scale_without_outliers, type ParamDefMap } from "../infertypes";
import { type Datapoint, ParamType } from "../types";

export interface ColorOrientation {
  /** Numeric axes whose values fall as the color rises, drawn with high values at the bottom. */
  readonly inverted: ReadonlySet<string>;
  /** Category order per categorical axis, lowest mean color first (at the bottom). */
  readonly categoryOrder: ReadonlyMap<string, readonly string[]>;
}

export const NO_ORIENTATION: ColorOrientation = { inverted: new Set(), categoryOrder: new Map() };

/**
 * Each row's position along a column's scale, from 0 to 1; NaN where the row
 * has no finite value. Positions, not raw values, so that log and percentile
 * axes correlate the way they are drawn.
 */
function unitPositions(
  rows: readonly Datapoint[],
  params_def: ParamDefMap,
  column: string,
): Float64Array {
  const pd = params_def[column];
  const positions = new Float64Array(rows.length).fill(Number.NaN);
  if (pd === undefined) {
    return positions;
  }
  const scale = create_d3_scale_without_outliers(pd).range([0, 1]);
  rows.forEach((row, index) => {
    positions[index] = scale(row[column]);
  });
  return positions;
}

/** Pearson correlation over the rows where both are finite; 0 when it is undefined. */
function correlation(xs: Float64Array, ys: Float64Array): number {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let i = 0; i < xs.length; ++i) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    n += 1;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const covariance = n * sumXY - sumX * sumY;
  const variance = (n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY);
  return variance > 0 ? covariance / Math.sqrt(variance) : 0;
}

/**
 * Categories ordered by the mean color of their rows, lowest first. Categories
 * without colored rows come first, and ties keep the axis' natural order.
 */
function orderByMeanColor(
  rows: readonly Datapoint[],
  params_def: ParamDefMap,
  column: string,
  colors: Float64Array,
): string[] {
  const pd = params_def[column];
  if (pd === undefined) {
    return [];
  }
  const scale = create_d3_scale_without_outliers(pd);
  if (scale.kind !== "categorical") {
    throw new Error(`Column ${column} is categorical without a categorical scale`);
  }
  const natural = scale.domain();
  const sums = new Map(natural.map((category) => [category, { total: 0, count: 0 }]));
  const positions = scale.range([0, natural.length - 1]);
  rows.forEach((row, index) => {
    const color = colors[index];
    const position = positions(row[column]);
    if (!Number.isFinite(color) || !Number.isFinite(position)) {
      return;
    }
    const sum = sums.get(natural[Math.round(position)]);
    if (sum !== undefined) {
      sum.total += color;
      sum.count += 1;
    }
  });
  const mean = (category: string): number => {
    const sum = sums.get(category);
    return sum === undefined || sum.count === 0 ? Number.NEGATIVE_INFINITY : sum.total / sum.count;
  };
  // Two categories without colored rows compare equal, keeping their order.
  return Array.from(natural).sort((a, b) => {
    const difference = mean(a) - mean(b);
    return Number.isNaN(difference) ? 0 : difference;
  });
}

/**
 * The orientation of every axis that makes high colors sit at the top. Only a
 * numeric color column has a gradient to follow; other color columns leave
 * every axis as it is.
 */
export function colorOrientation(
  rows: readonly Datapoint[],
  params_def: ParamDefMap,
  colorby: string,
): ColorOrientation {
  const colorDef = params_def[colorby];
  if (colorDef === undefined || colorDef.type === ParamType.CATEGORICAL) {
    return NO_ORIENTATION;
  }
  const colors = unitPositions(rows, params_def, colorby);
  const inverted = new Set<string>();
  const categoryOrder = new Map<string, readonly string[]>();
  for (const [column, pd] of Object.entries(params_def)) {
    if (column === colorby) {
      continue;
    }
    if (pd.type === ParamType.CATEGORICAL) {
      categoryOrder.set(column, orderByMeanColor(rows, params_def, column, colors));
    } else if (correlation(unitPositions(rows, params_def, column), colors) < 0) {
      inverted.add(column);
    }
  }
  return { inverted, categoryOrder };
}
