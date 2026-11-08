/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { FilterRange } from "../filters";
import { convert_to_categorical_input, parse_numeric } from "../lib/d3_scales";
import { type Datapoint, ParamType } from "../types";

/**
 * What the brushes of one axis select: the rows in any of these ranges. A brush
 * that selects no value has no range, so an empty list selects nothing.
 */
export type AxisSelection = ReadonlyArray<FilterRange>;

interface NumericColumn {
  values: Float64Array;
  missing: Uint8Array;
}

interface CategoricalColumn {
  codes: Int32Array;
  categories: string[];
}

const MISSING_CATEGORY = -1;

/**
 * Brush selection over a fixed set of rows, evaluated column by column on typed
 * arrays. Each axis keeps its own mask, the union of its ranges, recomputed
 * only when that axis's ranges change; the selected rows are the intersection
 * of the masks.
 *
 * Masks reproduce `filters.ts` exactly: a row is in a numeric range when its
 * parsed value is, or when it is inf/NaN and the range includes those; a row
 * is in a categorical range when its category is one of the range's values
 * (or, for a range without values, sorts between the bounds); a missing value
 * is never selected.
 */
export class BrushMasks {
  readonly rows: ReadonlyArray<Datapoint>;
  private readonly numericColumns = new Map<string, NumericColumn>();
  private readonly categoricalColumns = new Map<string, CategoricalColumn>();
  private readonly masks = new Map<string, { key: string; mask: Uint8Array }>();

  constructor(rows: ReadonlyArray<Datapoint>) {
    this.rows = rows;
  }

  private numericColumn(dimension: string): NumericColumn {
    const cached = this.numericColumns.get(dimension);
    if (cached !== undefined) {
      return cached;
    }
    const column: NumericColumn = {
      values: new Float64Array(this.rows.length),
      missing: new Uint8Array(this.rows.length),
    };
    this.rows.forEach((row, index) => {
      const value = row[dimension];
      if (value === undefined) {
        column.missing[index] = 1;
        return;
      }
      column.values[index] = parse_numeric(value);
    });
    this.numericColumns.set(dimension, column);
    return column;
  }

  private categoricalColumn(dimension: string): CategoricalColumn {
    const cached = this.categoricalColumns.get(dimension);
    if (cached !== undefined) {
      return cached;
    }
    const codeOf = new Map<string, number>();
    const column: CategoricalColumn = { codes: new Int32Array(this.rows.length), categories: [] };
    this.rows.forEach((row, index) => {
      const value = row[dimension];
      if (value === undefined) {
        column.codes[index] = MISSING_CATEGORY;
        return;
      }
      const category = convert_to_categorical_input(value);
      let code = codeOf.get(category);
      if (code === undefined) {
        code = column.categories.length;
        codeOf.set(category, code);
        column.categories.push(category);
      }
      column.codes[index] = code;
    });
    this.categoricalColumns.set(dimension, column);
    return column;
  }

  /** Sets to 1 the flag of every row in `range`, leaving the others as they are. */
  private addRange(mask: Uint8Array, range: FilterRange): void {
    if (range.type === ParamType.CATEGORICAL) {
      const { codes, categories } = this.categoricalColumn(range.col);
      const values = range.values === undefined ? null : new Set(range.values);
      const inRange = Uint8Array.from(categories, (category) =>
        values === null
          ? Number(range.min <= category && category <= range.max)
          : Number(values.has(category)),
      );
      for (let i = 0; i < codes.length; ++i) {
        const code = codes[i];
        if (code !== MISSING_CATEGORY) {
          mask[i] |= inRange[code];
        }
      }
      return;
    }
    const { min, max } = range;
    const includeInfNans = range.include_infnans === true;
    const { values, missing } = this.numericColumn(range.col);
    for (let i = 0; i < values.length; ++i) {
      const value = values[i];
      const selected =
        (min <= value && value <= max) || (includeInfNans && !Number.isFinite(value));
      if (selected && missing[i] === 0) {
        mask[i] = 1;
      }
    }
  }

  /** The rows selected on one axis, recomputed only when its ranges changed. */
  axisMask(dimension: string, selection: AxisSelection): Uint8Array {
    const key = JSON.stringify(selection);
    const cached = this.masks.get(dimension);
    if (cached !== undefined && cached.key === key) {
      return cached.mask;
    }
    const mask = new Uint8Array(this.rows.length);
    for (const range of selection) {
      this.addRange(mask, range);
    }
    this.masks.set(dimension, { key, mask });
    return mask;
  }

  /** 1 for every row inside all the given axis selections, 0 otherwise. */
  select(selections: ReadonlyMap<string, AxisSelection>): Uint8Array {
    const selected = new Uint8Array(this.rows.length).fill(1);
    selections.forEach((selection, dimension) => {
      const mask = this.axisMask(dimension, selection);
      for (let i = 0; i < selected.length; ++i) {
        selected[i] &= mask[i];
      }
    });
    return selected;
  }

  /** The selected rows, in their original order. */
  selectedRows(selected: Uint8Array): Datapoint[] {
    return this.rows.filter((_, index) => selected[index] === 1);
  }
}
