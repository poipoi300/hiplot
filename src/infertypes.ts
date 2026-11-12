/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import {
  continuousFromD3,
  d3_scale_categorical,
  d3_scale_percentile,
  d3_scale_timestamp,
  get_numeric_values_sorted,
  is_numeric_value,
  parse_numeric,
  type Scale,
  scale_add_outliers,
} from "./lib/d3_scales";
import { escapeHtml } from "./lib/escape";
import type { PersistentState } from "./lib/savedstate";
import { type Datapoint, type DatapointValue, type HiPlotValueDef, ParamType } from "./types";

export interface ParamDef extends HiPlotValueDef {
  name: string;
  type: ParamType;
  /** Retains the chosen scale when the current rows require a fallback. */
  type_requested?: ParamType;
  optional: boolean;
  numeric: boolean;
  distinct_values: Array<DatapointValue>;
  type_options: Array<ParamType>;
  label_css: string;
  label_html: string;
}

export interface ParamDefMap {
  [key: string]: ParamDef;
}

/** A scale built for one column, tagged with the column type it was built for. */
export type ParamScale = Scale & { readonly paramType: ParamType };

export function isParamType(value: unknown): value is ParamType {
  return Object.values(ParamType).includes(value as ParamType);
}

function get_min_max_for_numeric_scale(pd: ParamDef): [number, number] {
  let min = pd.force_value_min;
  let max = pd.force_value_max;
  for (const value of pd.distinct_values) {
    const parsed = parse_numeric(value);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    if (min === null || parsed < min) {
      min = parsed;
    }
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  if (min === null || max === null) {
    throw new Error(`Column "${pd.name}" has no finite value to build a numeric scale from`);
  }
  return [min, max];
}

function has_inf_or_nans(pd: ParamDef): boolean {
  return pd.distinct_values.some((value) => !Number.isFinite(parse_numeric(value)));
}

export function create_d3_scale_without_outliers(pd: ParamDef): Scale {
  const dv = pd.distinct_values;
  if (pd.type === ParamType.CATEGORICAL) {
    return d3_scale_categorical(dv);
  }
  if (pd.type === ParamType.NUMERICPERCENTILE) {
    return d3_scale_percentile(dv);
  }
  const [min, max] = get_min_max_for_numeric_scale(pd);
  console.assert(min <= max);
  if (pd.type === ParamType.TIMESTAMP) {
    return d3_scale_timestamp().domain([min, max]);
  }
  if (pd.type === ParamType.NUMERICLOG) {
    console.assert(min > 0, `Min value for "${pd.name}" is negative (${min}), can't use log-scale`);
    return continuousFromD3(d3.scaleLog().domain([min, max]));
  }
  return continuousFromD3(d3.scaleLinear().domain([min, max]));
}

const TYPES_WITH_OUTLIER_BAND: ReadonlyArray<ParamType> = [
  ParamType.NUMERIC,
  ParamType.NUMERICLOG,
  ParamType.NUMERICPERCENTILE,
];

export function create_d3_scale(pd: ParamDef): ParamScale {
  const scale = create_d3_scale_without_outliers(pd);
  const withOutliers =
    scale.kind === "continuous" && has_inf_or_nans(pd) && TYPES_WITH_OUTLIER_BAND.includes(pd.type)
      ? scale_add_outliers(scale)
      : scale;
  return Object.assign(withOutliers, { paramType: pd.type });
}

export type ScaleDomainRange =
  | {
      type: ParamType.CATEGORICAL;
      brush_extents_normalized: [number, number];
      values: Array<string>;
    }
  | {
      type: Exclude<ParamType, ParamType.CATEGORICAL>;
      brush_extents_normalized: [number, number];
      range: [number, number];
      include_infnans: boolean;
    };

/**
 * Converts scale range in pixels back to domain (aka inverts the scale)
 */
export function scale_pixels_range(
  scale: ParamScale,
  pixelExtents: readonly [number, number],
): ScaleDomainRange {
  const scaleToNorm = d3.scaleLinear().domain(scale.range()).range([0, 1]);
  const normalized: [number, number] = [scaleToNorm(pixelExtents[0]), scaleToNorm(pixelExtents[1])];
  if (scale.kind === "categorical") {
    const domain = scale.domain();
    const firstIdx = Math.ceil(Math.min(normalized[0], normalized[1]) * (domain.length - 1));
    const lastIdx = Math.floor(Math.max(normalized[0], normalized[1]) * (domain.length - 1) + 1);
    return {
      type: ParamType.CATEGORICAL,
      brush_extents_normalized: normalized,
      values: domain.slice(firstIdx, lastIdx),
    };
  }
  if (scale.paramType === ParamType.CATEGORICAL) {
    throw new Error("A categorical column must have a categorical scale");
  }
  const extents: [number, number] = [pixelExtents[0], pixelExtents[1]];
  const pxlRange = scale.range();
  // Small hack to make sure we can always select the extrema
  // (considering loss of precision in computations, especially for logscale)
  for (let i = 0; i < 2; ++i) {
    if (extents[i] === Math.min(...pxlRange)) {
      --extents[i];
    }
    if (extents[i] === Math.max(...pxlRange)) {
      ++extents[i];
    }
  }
  const infinityPixel = scale(Infinity);
  return {
    type: scale.paramType,
    brush_extents_normalized: normalized,
    range: [scale.invert(extents[0]), scale.invert(extents[1])],
    include_infnans: extents[0] <= infinityPixel && infinityPixel <= extents[1],
  };
}

/**
 * Ideally we want to infer:
 *  - If a variable is categorical
 *  - If a variable is numeric
 *  - If a variable is log-scaled
 */
export function infertypes(
  url_states: PersistentState,
  table: ReadonlyArray<Datapoint>,
  hints: { [key: string]: HiPlotValueDef & { type_requested?: ParamType } } = {},
  notify?: (message: string) => void,
): ParamDefMap {
  function infertype(
    key: string,
    hint: (HiPlotValueDef & { type_requested?: ParamType }) | undefined,
  ): ParamDef {
    const url_state = url_states.children(key);
    let optional = false;
    // A row's uid is a column like any other (a trial index is worth an
    // axis); from_uid only names another row.
    let numeric = key !== "from_uid";
    let can_be_timestamp = numeric;
    let valueCount = 0;
    const distinct = new Set<DatapointValue>();
    for (const row of table) {
      const v = row[key];
      if (v === undefined) {
        optional = true;
        continue;
      }
      valueCount += 1;
      distinct.add(v);
      if (typeof v === "number") {
        if (!Number.isSafeInteger(v) || v < 0) {
          can_be_timestamp = false;
        }
        continue;
      }
      can_be_timestamp = false;
      if (!is_numeric_value(v)) {
        numeric = false;
      }
    }
    const distinct_values = Array.from(distinct);
    const numericSorted = numeric ? get_numeric_values_sorted(distinct_values) : [];
    const hasFiniteValues = numericSorted.length > 0;
    const hasNumericDomain =
      hasFiniteValues ||
      (typeof hint?.force_value_min === "number" &&
        Number.isFinite(hint.force_value_min) &&
        typeof hint.force_value_max === "number" &&
        Number.isFinite(hint.force_value_max) &&
        hint.force_value_min <= hint.force_value_max);
    const forceValueMinNegative =
      hint !== undefined &&
      hint.force_value_min !== null &&
      hint.force_value_min !== undefined &&
      hint.force_value_min <= 0;
    const canBeLogScale =
      (hasFiniteValues
        ? numericSorted[0] > 0
        : hasNumericDomain && (hint?.force_value_min ?? 0) > 0) && !forceValueMinNegative;
    let spansMultipleOrdersOfMagnitude = false;
    if (numericSorted.length > 10 && numericSorted[0] > 0) {
      const top5pct =
        numericSorted[Math.min(numericSorted.length - 1, ~~((19 * numericSorted.length) / 20))];
      const bot5pct = numericSorted[~~(numericSorted.length / 20)];
      spansMultipleOrdersOfMagnitude = top5pct / bot5pct > 100;
    }
    const categorical =
      !numeric ||
      !hasFiniteValues ||
      (Math.max(valueCount, 10) / distinct_values.length > 10 && distinct_values.length < 6);
    let inferred = ParamType.CATEGORICAL;
    if (numeric && !categorical) {
      inferred = ParamType.NUMERIC;
      if (spansMultipleOrdersOfMagnitude) {
        inferred = canBeLogScale ? ParamType.NUMERICLOG : ParamType.NUMERICPERCENTILE;
      }
    }
    const persisted = url_state.get("type");
    const requested =
      hint?.type_requested ?? hint?.type ?? (isParamType(persisted) ? persisted : null);
    let type = requested ?? inferred;
    let problem: string | null = null;
    if (type !== ParamType.CATEGORICAL) {
      if (!numeric) {
        problem = "the column contains non-numeric values";
      } else if (!hasNumericDomain || (type === ParamType.NUMERICPERCENTILE && !hasFiniteValues)) {
        problem = "the column has no finite numeric values";
      } else if (type === ParamType.NUMERICLOG && !canBeLogScale) {
        problem = "a logarithmic scale requires a positive domain";
      }
      if (problem !== null) {
        type = inferred;
      }
    } else if (requested === null && numeric && !hasFiniteValues) {
      problem = "the column has no finite numeric values";
    }
    if (problem !== null) {
      notify?.(`Column "${key}": ${problem}; using a ${type} scale instead.`);
    }

    // What other types we can render as?
    const type_options = [ParamType.CATEGORICAL];
    if (numeric && hasNumericDomain) {
      type_options.push(ParamType.NUMERIC);
      if (canBeLogScale) {
        type_options.push(ParamType.NUMERICLOG);
      }
      if (hasFiniteValues) {
        type_options.push(ParamType.NUMERICPERCENTILE);
      }
      if (can_be_timestamp) {
        type_options.push(ParamType.TIMESTAMP);
      }
    }
    return {
      name: key,
      optional,
      numeric,
      distinct_values,
      type_options,
      type,
      type_requested: requested ?? inferred,
      colors: hint?.colors ?? null,
      colormap: hint?.colormap ?? null,
      force_value_min: hint?.force_value_min ?? null,
      force_value_max: hint?.force_value_max ?? null,
      label_css: hint?.label_css ?? "",
      label_html: hint?.label_html ?? escapeHtml(key),
    };
  }
  // First, get a set of all the columns
  const allKeys = new Set<string>();
  table.forEach((row) => {
    Object.keys(row).forEach((k: string) => {
      allKeys.add(k);
    });
  });
  const ret: ParamDefMap = {};
  allKeys.forEach((key) => {
    ret[key] = infertype(key, hints[key]);
  });
  return ret;
}
