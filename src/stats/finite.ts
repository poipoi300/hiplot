/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Whether every entry is a finite number. */
export function allFinite(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; ++index) {
    if (!Number.isFinite(values[index])) {
      return false;
    }
  }
  return true;
}

/**
 * The rows where every column holds a finite number, as one array per
 * column. Columns must have equal length.
 */
export function finiteColumns(...columns: ReadonlyArray<ArrayLike<number>>): number[][] {
  const rowCount = columns[0]?.length ?? 0;
  if (columns.some((column) => column.length !== rowCount)) {
    throw new Error(
      `columns must have equal length, got ${columns.map((column) => column.length).join(", ")}`,
    );
  }
  const kept: number[][] = columns.map(() => []);
  for (let row = 0; row < rowCount; ++row) {
    if (columns.every((column) => Number.isFinite(column[row]))) {
      columns.forEach((column, columnIndex) => {
        kept[columnIndex].push(column[row]);
      });
    }
  }
  return kept;
}

/** The finite entries of `values`, in order. */
export function finiteValues(values: ArrayLike<number>): number[] {
  return finiteColumns(values)[0];
}

/** Arithmetic mean; NaN for an empty array. */
export function mean(values: ReadonlyArray<number>): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/**
 * Whether every entry equals the first. Variance is judged by this rather
 * than by a computed sum of squares, which rounding leaves slightly positive
 * for constant data.
 */
export function isConstant(values: ArrayLike<number>): boolean {
  for (let index = 1; index < values.length; ++index) {
    if (values[index] !== values[0]) {
      return false;
    }
  }
  return true;
}
