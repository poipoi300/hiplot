/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { convert_to_categorical_input } from "./lib/d3_scales";
import { escapeRegExp } from "./lib/escape";
import { isStringArray } from "./lib/savedstate";
import { type Datapoint, type DatapointValue, ParamType } from "./types";

export enum FilterType {
  All = "All",
  Range = "Range",
  /** Rows meeting at least one of several filters, such as the brushes of one axis. */
  Any = "Any",
  Not = "Not",
  Search = "Search",
  Column = "Column",
  None = "None",
}

export type FilterRange =
  | {
      col: string;
      type: ParamType.CATEGORICAL;
      min: string;
      max: string;
      /**
       * The categories selected. Filters saved before it existed select the
       * categories whose string sorts between `min` and `max` instead.
       */
      values?: string[];
    }
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
  | { type: FilterType.Any; data: Filter[] }
  | { type: FilterType.Not; data: Filter }
  | { type: FilterType.Search; data: string }
  | { type: FilterType.Column; data: { col: string; query: string } }
  | { type: FilterType.None; data: Record<string, never> };

/**
 * A condition typed into a table column's filter: a comparison or a range
 * (`>0.5`, `<=1e-3`, `=3`, `0.1..0.5`), which only numbers meet, or else a
 * case-insensitive substring of the value.
 */
export type ColumnCondition =
  | { kind: "compare"; operator: "<" | "<=" | ">" | ">=" | "="; value: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "text"; text: string };

const COMPARISON = /^(<=|>=|<|>|=)\s*(\S+)$/;
const RANGE = /^(\S+?)\s*\.\.\s*(\S+)$/;

/** The condition a column filter's text describes; null when it is blank. */
export function parseColumnCondition(query: string): ColumnCondition | null {
  const text = query.trim();
  if (text === "") {
    return null;
  }
  const comparison = COMPARISON.exec(text);
  if (comparison !== null && Number.isFinite(Number(comparison[2]))) {
    const operator = comparison[1] as "<" | "<=" | ">" | ">=" | "=";
    return { kind: "compare", operator, value: Number(comparison[2]) };
  }
  const range = RANGE.exec(text);
  if (range !== null && Number.isFinite(Number(range[1])) && Number.isFinite(Number(range[2]))) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return { kind: "range", min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { kind: "text", text: text.toLowerCase() };
}

/** Whether a cell value meets a column condition. */
export function columnConditionHolds(condition: ColumnCondition, value: DatapointValue): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (condition.kind === "text") {
    return String(value).toLowerCase().includes(condition.text);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return false;
  }
  if (condition.kind === "range") {
    return condition.min <= number && number <= condition.max;
  }
  switch (condition.operator) {
    case "<":
      return number < condition.value;
    case "<=":
      return number <= condition.value;
    case ">":
      return number > condition.value;
    case ">=":
      return number >= condition.value;
    case "=":
      return number === condition.value;
  }
}

type Predicate = (dp: Datapoint) => boolean;

function filter_range(data: FilterRange): Predicate {
  if (data.type === ParamType.CATEGORICAL) {
    const selected = data.values === undefined ? null : new Set(data.values);
    return (dp: Datapoint) => {
      const value = dp[data.col];
      if (value === undefined) {
        return false;
      }
      const category = convert_to_categorical_input(value);
      return selected === null
        ? data.min <= category && category <= data.max
        : selected.has(category);
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
    case FilterType.Any: {
      const predicates = filter.data.map(filter_predicate);
      return (dp) => predicates.some((fn) => fn(dp));
    }
    case FilterType.Not: {
      const predicate = filter_predicate(filter.data);
      return (dp) => !predicate(dp);
    }
    case FilterType.Search:
      return filter_search(filter.data);
    case FilterType.Column: {
      const { col, query } = filter.data;
      const condition = parseColumnCondition(query);
      return condition === null ? () => true : (dp) => columnConditionHolds(condition, dp[col]);
    }
    case FilterType.None:
      return () => false;
  }
}

/**
 * The filter of one axis's brushes: rows in any of its ranges. No range selects
 * nothing, and a single range stays a plain range filter.
 */
export function anyOfRanges(ranges: ReadonlyArray<FilterRange>): Filter {
  if (ranges.length === 0) {
    return { type: FilterType.None, data: {} };
  }
  if (ranges.length === 1) {
    return { type: FilterType.Range, data: ranges[0] };
  }
  return {
    type: FilterType.Any,
    data: ranges.map((range): Filter => ({ type: FilterType.Range, data: range })),
  };
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
    return (
      typeof value.min === "string" &&
      typeof value.max === "string" &&
      (value.values === undefined || isStringArray(value.values))
    );
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
    case FilterType.Any:
      return Array.isArray(value.data) && value.data.every(isFilter);
    case FilterType.Range:
      return isFilterRange(value.data);
    case FilterType.Not:
      return isFilter(value.data);
    case FilterType.Search:
      return typeof value.data === "string";
    case FilterType.Column:
      return (
        isRecord(value.data) &&
        typeof value.data.col === "string" &&
        typeof value.data.query === "string"
      );
    case FilterType.None:
      return isRecord(value.data);
    default:
      return false;
  }
}
