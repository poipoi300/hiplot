/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import color from "color";
import * as d3 from "d3";
import { create_d3_scale_without_outliers, type ParamDef } from "../infertypes";
import { type DatapointValue, ParamType } from "../types";
import { categoricalColorScheme } from "./categoricalcolors";
import { is_special_numeric } from "./d3_scales";

/** An sRGB color with 0-255 channels. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Numeric columns are colored with this many evenly spaced samples of the color map. */
export const NUMERIC_COLOR_BINS = 256;

const MISSING_RGB: RGB = { r: 100, g: 100, b: 100 };

/**
 * Colors of one color-by column, quantized into bins so rows can be grouped by
 * color and every color is parsed once: one bin per category, or
 * NUMERIC_COLOR_BINS samples of the color map. The last bin holds missing and
 * special values, drawn grey.
 */
export interface ColorBinning {
  binOf(value: DatapointValue): number;
  readonly palette: ReadonlyArray<RGB>;
  readonly missingBin: number;
  /** CSS color of a bin at the given opacity, cached. */
  css(bin: number, alpha: number): string;
}

/** Maps a position in [0, 1] to a CSS color. */
export type ColorMap = (t: number) => string;

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

function parseRGB(css: string): RGB {
  const { r, g, b } = color(css).rgb().object();
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
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

/** Parses `interpolateX` / `schemeX`, with optional `#inverse`, into a color map. */
export function parseColorMap(full_name: string, description: string): ColorMap {
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

function makeBinning(palette: RGB[], binOf: (value: DatapointValue) => number): ColorBinning {
  const missingBin = palette.length;
  const withMissing = [...palette, MISSING_RGB];
  const cssByAlpha = new Map<number, string[]>();
  return {
    binOf,
    palette: withMissing,
    missingBin,
    css(bin: number, alpha: number): string {
      let cache = cssByAlpha.get(alpha);
      if (cache === undefined) {
        cache = withMissing.map(({ r, g, b }) => `rgba(${r}, ${g}, ${b}, ${alpha})`);
        cssByAlpha.set(alpha, cache);
      }
      return cache[bin];
    },
  };
}

function categoricalBinning(pd: ParamDef): ColorBinning {
  const binByValue = new Map<string, number>();
  const palette: RGB[] = [];
  pd.distinct_values.forEach((value, i) => {
    const key = String(value);
    if (binByValue.has(key)) {
      return;
    }
    const userColor = pd.colors?.[key];
    const css =
      userColor ??
      (pd.distinct_values.length <= CATEGORICAL_SCHEME.length
        ? CATEGORICAL_SCHEME[i]
        : categoricalColorScheme(key));
    binByValue.set(key, palette.length);
    palette.push(parseRGB(css));
  });
  const missingBin = palette.length;
  return makeBinning(palette, (value) => binByValue.get(String(value)) ?? missingBin);
}

function numericBinning(pd: ParamDef, defaultColorMap: string | null): ColorBinning {
  const colorMap = pd.colormap
    ? parseColorMap(pd.colormap, `for column ${pd.name}`)
    : parseColorMap(defaultColorMap ?? "", "(global default color map)");
  const palette = Array.from({ length: NUMERIC_COLOR_BINS }, (_, bin) => {
    const css = colorMap(bin / (NUMERIC_COLOR_BINS - 1));
    try {
      return parseRGB(css);
    } catch (err) {
      throw new Error(
        `Error below happened while computing color using color map "${pd.colormap}" for column ${pd.name}: is the colormap valid? (${String(err)})`,
      );
    }
  });
  const scale = create_d3_scale_without_outliers(pd);
  scale.range([0, 1]);
  return makeBinning(palette, (value) => {
    if (value === undefined || value === null || is_special_numeric(value)) {
      return NUMERIC_COLOR_BINS;
    }
    const t = Math.max(0, Math.min(1, scale(value)));
    return Number.isNaN(t) ? NUMERIC_COLOR_BINS : Math.round(t * (NUMERIC_COLOR_BINS - 1));
  });
}

/** Builds the color bins of a color-by column. */
export function colorBinning(pd: ParamDef, defaultColorMap: string | null): ColorBinning {
  return pd.type === ParamType.CATEGORICAL
    ? categoricalBinning(pd)
    : numericBinning(pd, defaultColorMap);
}
