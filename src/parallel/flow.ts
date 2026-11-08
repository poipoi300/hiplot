/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { convert_to_categorical_input } from "../lib/d3_scales";
import type { Datapoint } from "../types";

/** A categorical axis next to a brushed one, and the side the brushed neighbor is on. */
export interface FlowAxis {
  dimension: string;
  from: "left" | "right";
}

/**
 * The categorical axes that sit next to a brushed axis: where the selection
 * flows in from the brush. An axis between two brushed neighbors takes the
 * one on its left.
 */
export function flowAxes(
  dimensions: ReadonlyArray<string>,
  brushed: ReadonlySet<string>,
  isCategorical: (dimension: string) => boolean,
): FlowAxis[] {
  const axes: FlowAxis[] = [];
  dimensions.forEach((dimension, index) => {
    if (!isCategorical(dimension)) {
      return;
    }
    if (index > 0 && brushed.has(dimensions[index - 1])) {
      axes.push({ dimension, from: "left" });
    } else if (index < dimensions.length - 1 && brushed.has(dimensions[index + 1])) {
      axes.push({ dimension, from: "right" });
    }
  });
  return axes;
}

/** Each row's index in `categories`, or -1 for a missing or unknown value. */
export function categoryIndices(
  rows: ReadonlyArray<Datapoint>,
  column: string,
  categories: ReadonlyArray<string>,
): Int32Array {
  const indexOf = new Map(categories.map((category, index) => [category, index]));
  const indices = new Int32Array(rows.length);
  rows.forEach((row, index) => {
    const value = row[column];
    indices[index] =
      value === undefined ? -1 : (indexOf.get(convert_to_categorical_input(value)) ?? -1);
  });
  return indices;
}

/** How many selected rows (mask 1) fall in each of `categoryCount` categories. */
export function countByCategory(
  indices: Int32Array,
  selected: Uint8Array,
  categoryCount: number,
): Uint32Array {
  if (indices.length !== selected.length) {
    throw new Error("Category indices and selection flags cover different rows");
  }
  const counts = new Uint32Array(categoryCount);
  for (let row = 0; row < indices.length; ++row) {
    const category = indices[row];
    if (selected[row] !== 0 && category >= 0) {
      counts[category] += 1;
    }
  }
  return counts;
}
