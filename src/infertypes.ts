/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import color from "color";
import * as d3 from "d3";
import { categoricalColorScheme } from "./lib/categoricalcolors";
import {
  continuousFromD3,
  d3_scale_categorical,
  d3_scale_percentile,
  d3_scale_timestamp,
  get_numeric_values_sorted,
  is_special_numeric,
  type Scale,
  scale_add_outliers,
} from "./lib/d3_scales";
import { escapeHtml } from "./lib/escape";
import type { PersistentState } from "./lib/savedstate";
import { type Datapoint, type DatapointValue, type HiPlotValueDef, ParamType } from "./types";

export interface ParamDef extends HiPlotValueDef {
  name: string;
  type: ParamType;
  optional: boolean;
  numeric: boolean;
  distinct_values: Array<DatapointValue>;
  type_options: Array<ParamType>;
  ticks_format?: string;
  label_css: string;
  label_html: string;
  __val2color?: { [value: string]: string };
  __colorscale?: { scale: Scale; type: ParamType };
  __colormap?: ColorMap;
}

export interface ParamDefMap {
  [key: string]: ParamDef;
}

/** A scale built for one column, tagged with the column type it was built for. */
export type ParamScale = Scale & { readonly paramType: ParamType };

/** Maps a position in [0, 1] to a CSS color. */
type ColorMap = (t: number) => string;

export function isParamType(value: unknown): value is ParamType {
  return Object.values(ParamType).includes(value as ParamType);
}

function get_min_max_for_numeric_scale(pd: ParamDef): [number, number] {
  let min = pd.force_value_min;
  let max = pd.force_value_max;
  pd.distinct_values.forEach((value) => {
    const parsed = parseFloat(String(value));
    if (is_special_numeric(parsed)) {
      return;
    }
    if (min === null || parsed < min) {
      min = parsed;
    }
    if (max === null || parsed > max) {
      max = parsed;
    }
  });
  if (min === null || max === null) {
    throw new Error(`Column "${pd.name}" has no finite value to build a numeric scale from`);
  }
  return [min, max];
}

function has_inf_or_nans(pd: ParamDef): boolean {
  return pd.distinct_values.some((value) => is_special_numeric(parseFloat(String(value))));
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

const CATEGORICAL_SCHEME = [
  "#1f77b4",
  "#ff7f0e",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#1f77b4",
  "#aec7e8",
  "#ffbb78",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#c7c7c7",
  "#dbdb8d",
  "#9edae5",
  "#2ca02c",
];

function compute_val2color(pd: ParamDef): { [value: string]: string } {
  if (pd.__val2color !== undefined) {
    return pd.__val2color;
  }
  const val2color: { [value: string]: string } = { ...pd.colors };
  pd.distinct_values.forEach((value, i) => {
    const key = String(value);
    if (val2color[key]) {
      return;
    }
    val2color[key] =
      pd.distinct_values.length <= CATEGORICAL_SCHEME.length
        ? color(CATEGORICAL_SCHEME[i]).rgb().string()
        : categoricalColorScheme(key);
  });
  pd.__val2color = val2color;
  return val2color;
}

function lookupD3ColorExport(name: string, description: string): unknown {
  const exported = (d3 as unknown as { [name: string]: unknown })[name];
  if (exported === undefined) {
    throw new Error(`Invalid color map ${name} ${description}`);
  }
  return exported;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A d3 scheme is either a list of colors or a list of such lists indexed by size. */
function schemeColors(scheme: unknown, name: string): string[] {
  if (isStringArray(scheme)) {
    return scheme;
  }
  if (Array.isArray(scheme)) {
    const largest: unknown = scheme[scheme.length - 1];
    if (isStringArray(largest)) {
      return largest;
    }
  }
  throw new Error(`Color scheme ${name} is not a list of colors`);
}

function parseColorMap(full_name: string, description: string): ColorMap {
  if (!full_name) {
    return d3.interpolateTurbo;
  }
  const [name, modifiers] = full_name.split("#");
  const exported = lookupD3ColorExport(name, description);
  let fn: ColorMap;
  if (name.startsWith("interpolate")) {
    if (typeof exported !== "function") {
      throw new Error(`Invalid color map ${name} ${description}`);
    }
    const interpolate = exported as (t: number) => string;
    fn = (t) => interpolate(t);
  } else {
    const colors = schemeColors(exported, name);
    fn = (t) => colors[Math.max(0, Math.min(colors.length - 1, Math.floor(t * colors.length)))];
  }
  if (modifiers !== undefined) {
    modifiers.split(",").forEach((modifier_name) => {
      if (modifier_name === "inverse") {
        const orig_fn = fn;
        fn = (t) => orig_fn(-t);
      }
    });
  }
  return fn;
}

function getColorMap(pd: ParamDef, defaultColorMap: string | null): ColorMap {
  if (pd.colormap) {
    if (pd.__colormap === undefined) {
      pd.__colormap = parseColorMap(pd.colormap, `for column ${pd.name}`);
    }
    return pd.__colormap;
  }
  return parseColorMap(defaultColorMap ?? "", `(global default color map)`);
}

const MISSING_COLOR = (alpha: number): string => `rgb(100,100,100,${alpha})`;

export function colorScheme(
  pd: ParamDef,
  value: DatapointValue,
  alpha: number,
  defaultColorMap: string | null,
): string {
  if (pd.type === ParamType.CATEGORICAL) {
    const c = compute_val2color(pd)[String(value)];
    if (c === undefined) {
      return MISSING_COLOR(alpha);
    }
    console.assert(c.startsWith("rgb(") || c.startsWith("hsl("), c);
    return `${c.slice(0, 3)}a${c.slice(3, c.length - 1)},${alpha})`;
  }
  if (value === undefined || value === null || is_special_numeric(value)) {
    return MISSING_COLOR(alpha);
  }
  if (pd.__colorscale === undefined || pd.__colorscale.type !== pd.type) {
    const scale = create_d3_scale_without_outliers(pd);
    scale.range([0, 1]);
    pd.__colorscale = { scale, type: pd.type };
  }
  const colr = Math.max(0, Math.min(1, pd.__colorscale.scale(value)));
  const interpColFn = getColorMap(pd, defaultColorMap);
  try {
    const rgb = color(interpColFn(colr)).rgb().object();
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  } catch (err) {
    throw new Error(
      `Error below happened while computing color using color map "${pd.colormap}" for column ${pd.name}: is the colormap valid? (${String(err)})`,
    );
  }
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
  hints: { [key: string]: HiPlotValueDef } = {},
): ParamDefMap {
  function infertype(key: string, hint: HiPlotValueDef | undefined): ParamDef {
    const url_state = url_states.children(key);
    let optional = false;
    let numeric = ["uid", "from_uid"].indexOf(key) === -1;
    let can_be_timestamp = numeric;
    const values: DatapointValue[] = [];
    const addValue = (v: DatapointValue): void => {
      if (v === undefined) {
        optional = true;
        return;
      }
      values.push(v);
      // Detect non-numeric column
      if (
        (typeof v !== "number" && !is_special_numeric(v) && Number.isNaN(Number(v))) ||
        typeof v === "boolean"
      ) {
        numeric = false;
        can_be_timestamp = false;
      }
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
        can_be_timestamp = false;
      }
    };
    table.forEach((row) => {
      addValue(row[key]);
    });
    const distinct_values = Array.from(new Set(values));
    const numericSorted = numeric ? get_numeric_values_sorted(distinct_values) : [];
    const forceValueMinNegative =
      hint !== undefined &&
      hint.force_value_min !== null &&
      hint.force_value_min !== undefined &&
      hint.force_value_min <= 0;
    const canBeLogScale = numericSorted[0] > 0 && !forceValueMinNegative;
    let spansMultipleOrdersOfMagnitude = false;
    if (numericSorted.length > 10 && numericSorted[0] > 0) {
      const top5pct =
        numericSorted[Math.min(numericSorted.length - 1, ~~((19 * numericSorted.length) / 20))];
      const bot5pct = numericSorted[~~(numericSorted.length / 20)];
      spansMultipleOrdersOfMagnitude = top5pct / bot5pct > 100;
    }
    const categorical =
      !numeric ||
      (Math.max(values.length, 10) / distinct_values.length > 10 && distinct_values.length < 6);
    let inferred = ParamType.CATEGORICAL;
    if (numeric && !categorical) {
      inferred = ParamType.NUMERIC;
      if (spansMultipleOrdersOfMagnitude) {
        inferred = canBeLogScale ? ParamType.NUMERICLOG : ParamType.NUMERICPERCENTILE;
      }
    }
    let type: ParamType;
    if (hint !== undefined && hint.type !== null && hint.type !== undefined) {
      type = hint.type;
    } else {
      const persisted = url_state.get("type");
      type = isParamType(persisted) ? persisted : inferred;
    }

    // What other types we can render as?
    const type_options = [ParamType.CATEGORICAL];
    if (numeric) {
      type_options.push(ParamType.NUMERIC);
      if (canBeLogScale) {
        type_options.push(ParamType.NUMERICLOG);
      }
      type_options.push(ParamType.NUMERICPERCENTILE);
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
      ticks_format: type === ParamType.NUMERICLOG ? ".1e" : undefined,
      type,
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
