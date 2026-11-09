/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { ParamScale } from "../infertypes";
import type { ColorBinning, ColorMode } from "../lib/colors";
import type { Datapoint } from "../types";

interface CachedColumn {
  scale: ParamScale;
  range: [number, number];
  pixels: Float32Array;
}

/** Fisher-Yates permutation of 0..n-1 drawn from `random`. */
export function shuffledIndices(n: number, random: () => number = Math.random): Uint32Array {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; ++i) {
    order[i] = i;
  }
  for (let i = n - 1; i > 0; --i) {
    const j = Math.floor(random() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}

/**
 * Per-row geometry of the parallel plot for one set of rows: the vertical pixel
 * of every row on every axis, its color bin, and a draw order shuffled once.
 *
 * Columns are computed lazily and kept until their scale changes (a new scale
 * object, or a new range after a resize or an inversion), so redraws, reorders
 * and brushing never re-evaluate scales.
 */
export class LineGeometry {
  readonly rows: ReadonlyArray<Datapoint>;
  /** Row indices in the order lines are drawn. */
  readonly order: Uint32Array;
  private readonly indexOfRow: Map<Datapoint, number>;
  private readonly columns = new Map<string, CachedColumn>();
  private colors: { binning: ColorBinning; colorby: string; bins: Uint32Array } | null = null;
  private colorOrderMemo: { bins: Uint32Array; mode: ColorMode; order: Uint32Array } | null = null;

  constructor(rows: ReadonlyArray<Datapoint>, random: () => number = Math.random) {
    this.rows = rows;
    this.order = shuffledIndices(rows.length, random);
    this.indexOfRow = new Map();
    for (let index = 0; index < rows.length; ++index) {
      this.indexOfRow.set(rows[index], index);
    }
  }

  /** Index of a row in `rows`; throws for rows of another dataset. */
  indexOf(row: Datapoint): number {
    const index = this.indexOfRow.get(row);
    if (index === undefined) {
      throw new Error(`Row ${row.uid} is not part of the plotted rows`);
    }
    return index;
  }

  /**
   * Pixel y of every row on the axis of `dimension`; NaN where the row has no
   * position (missing value, or a numeric column's "inf"/"-inf" text).
   */
  pixels(dimension: string, scale: ParamScale, numeric: boolean): Float32Array {
    const range = scale.range();
    const cached = this.columns.get(dimension);
    if (
      cached !== undefined &&
      cached.scale === scale &&
      cached.range[0] === range[0] &&
      cached.range[1] === range[1]
    ) {
      return cached.pixels;
    }
    const pixels = new Float32Array(this.rows.length);
    this.rows.forEach((row, index) => {
      const value = row[dimension];
      const missing = value === undefined || (numeric && (value === "inf" || value === "-inf"));
      pixels[index] = missing ? Number.NaN : scale(value);
    });
    this.columns.set(dimension, { scale, range, pixels });
    return pixels;
  }

  /** Color bin of every row for the given color-by column. */
  colorBins(binning: ColorBinning, colorby: string): Uint32Array {
    if (
      this.colors !== null &&
      this.colors.binning === binning &&
      this.colors.colorby === colorby
    ) {
      return this.colors.bins;
    }
    const bins = new Uint32Array(this.rows.length);
    this.rows.forEach((row, index) => {
      bins[index] = binning.binOf(row[colorby]);
    });
    this.colors = { binning, colorby, bins };
    return bins;
  }

  /**
   * The draw order with the lowest or highest color values last, where
   * alpha blending puts them on top: rows sorted by the bin of a numeric
   * color map (`colorMapBins` leading bins), rows past it (missing values)
   * first, and the shuffled order kept among rows of one bin. The shuffled
   * order itself for the "mean" mode or a categorical column (no color map).
   */
  colorOrder(bins: Uint32Array, colorMapBins: number, mode: ColorMode): Uint32Array {
    if (mode === "mean" || colorMapBins === 0) {
      return this.order;
    }
    const memo = this.colorOrderMemo;
    if (memo !== null && memo.bins === bins && memo.mode === mode) {
      return memo.order;
    }
    // Counting sort on the rank: 0 for missing values, then the bins toward the top.
    const rankOf = (bin: number): number =>
      bin >= colorMapBins ? 0 : 1 + (mode === "highest" ? bin : colorMapBins - 1 - bin);
    const starts = new Uint32Array(colorMapBins + 2);
    for (const row of this.order) {
      starts[rankOf(bins[row]) + 1] += 1;
    }
    for (let rank = 1; rank < starts.length; ++rank) {
      starts[rank] += starts[rank - 1];
    }
    const order = new Uint32Array(this.order.length);
    for (const row of this.order) {
      order[starts[rankOf(bins[row])]++] = row;
    }
    this.colorOrderMemo = { bins, mode, order };
    return order;
  }
}
