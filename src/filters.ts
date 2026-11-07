/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { convert_to_categorical_input } from "./lib/d3_scales";
import { escapeRegExp } from "./lib/escape";
import { type Datapoint, ParamType } from "./types";

export enum FilterType {
  All = "All",
  Range = "Range",
  Not = "Not",
  Search = "Search",
  None = "None",
}

export type FilterRange =
  | { col: string; type: ParamType.CATEGORICAL; min: string; max: string }
  | {
      col: string;
      type: Exclude<ParamType, ParamType.CATEGORICAL>;
      min: number;
      max: number;
      include_infnans?: boolean;
    };

/** A serializable row predicate; filters persist in the URL and are sent to Python. */
export type Filter =
  | { type: FilterType.All; data: Filter[] }
  | { type: FilterType.Range; data: FilterRange }
  | { type: FilterType.Not; data: Filter }
  | { type: FilterType.Search; data: string }
  | { type: FilterType.None; data: Record<string, never> };

type Predicate = (dp: Datapoint) => boolean;

function filter_range(data: FilterRange): Predicate {
  if (data.type === ParamType.CATEGORICAL) {
    return (dp: Datapoint) => {
      const value = dp[data.col];
      if (value === undefined) {
        return false;
      }
      const category = convert_to_categorical_input(value);
      return data.min <= category && category <= data.max;
    };
  }
  return (dp: Datapoint) => {
    const raw = dp[data.col];
    if (raw === undefined) {
      return false;
    }
    const value = parseFloat(String(raw));
    if (data.min <= value && value <= data.max) {
      return true;
    }
    // Not in `[min, max]`, but inf and nans may be selected too
    return data.include_infnans === true && !Number.isFinite(value);
  };
}

/** Case-insensitive substring match over every cell of the row, as the table search does. */
function filter_search(data: string): Predicate {
  const regexp = new RegExp(escapeRegExp(data), "i");
  return (dp: Datapoint) => regexp.test(Object.values(dp).join("  "));
}

export function filter_predicate(filter: Filter): Predicate {
  switch (filter.type) {
    case FilterType.All: {
      const predicates = filter.data.map(filter_predicate);
      return (dp) => predicates.every((fn) => fn(dp));
    }
    case FilterType.Range:
      return filter_range(filter.data);
    case FilterType.Not: {
      const predicate = filter_predicate(filter.data);
      return (dp) => !predicate(dp);
    }
    case FilterType.Search:
      return filter_search(filter.data);
    case FilterType.None:
      return () => false;
  }
}

export function apply_filter(rows: ReadonlyArray<Datapoint>, filter: Filter): Array<Datapoint> {
  return rows.filter(filter_predicate(filter));
}

export function apply_filters(
  rows: ReadonlyArray<Datapoint>,
  filters: ReadonlyArray<Filter>,
): Array<Datapoint> {
  let filtered = rows.slice();
  filters.forEach((filter) => {
    filtered = apply_filter(filtered, filter);
  });
  return filtered;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterRange(value: unknown): value is FilterRange {
  if (!isRecord(value) || typeof value.col !== "string") {
    return false;
  }
  if (value.type === ParamType.CATEGORICAL) {
    return typeof value.min === "string" && typeof value.max === "string";
  }
  return (
    Object.values(ParamType).includes(value.type as ParamType) &&
    typeof value.min === "number" &&
    typeof value.max === "number" &&
    (value.include_infnans === undefined || typeof value.include_infnans === "boolean")
  );
}

/** Validates a filter read back from untyped storage (the URL, a saved state). */
export function isFilter(value: unknown): value is Filter {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case FilterType.All:
      return Array.isArray(value.data) && value.data.every(isFilter);
    case FilterType.Range:
      return isFilterRange(value.data);
    case FilterType.Not:
      return isFilter(value.data);
    case FilterType.Search:
      return typeof value.data === "string";
    case FilterType.None:
      return isRecord(value.data);
    default:
      return false;
  }
}
