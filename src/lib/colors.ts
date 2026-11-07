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
import {
  convert_to_categorical_input,
  is_special_numeric,
  naturalSortComparator,
} from "./d3_scales";

/** An sRGB color with 0-255 channels. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Numeric columns are colored with this many evenly spaced samples of the color map. */
export const NUMERIC_COLOR_BINS = 256;

/** What a legend shows for a color-by column. */
export type ColorLegend =
  | { kind: "categorical"; categories: ReadonlyArray<string> }
  | { kind: "numeric"; domain: [number, number] };

/**
 * Colors of one color-by column, quantized into bins so rows can be grouped by
 * color and every color is parsed once: one bin per category (in axis order),
 * or NUMERIC_COLOR_BINS samples of the color map. The last bin holds missing
 * and special values, drawn grey.
 */
export interface ColorBinning {
  binOf(value: DatapointValue): number;
  readonly palette: ReadonlyArray<RGB>;
  readonly missingBin: number;
  readonly legend: ColorLegend;
  /** CSS color of a bin at the given opacity, cached. */
  css(bin: number, alpha: number): string;
}

/** Maps a position in [0, 1] to a CSS color. */
export type ColorMap = (t: number) => string;

/** Theme the colors are drawn on: dark backgrounds need lighter ends of a scale. */
export type ColorTheme = "light" | "dark";

/**
 * Okabe & Ito's palette for color-vision deficiency, without black (invisible on
 * the dark theme) and with yellow last (weakest on the light one).
 */
export const OKABE_ITO = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#D55E00",
  "#56B4E9",
  "#CC79A7",
  "#F0E442",
];
/** Tableau 10, for 8 to 10 categories. */
export const TABLEAU_10 = [
  "#4E79A7",
  "#F28E2B",
  "#E15759",
  "#76B7B2",
  "#59A14F",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
];

const MISSING: { [theme in ColorTheme]: RGB } = {
  light: { r: 154, g: 160, b: 166 },
  dark: { r: 125, g: 132, b: 140 },
};

/** Default numeric color map: viridis, starting lighter on the dark theme so low values stay visible. */
function defaultColorMap(theme: ColorTheme): ColorMap {
  return theme === "dark" ? (t) => d3.interpolateViridis(0.18 + 0.82 * t) : d3.interpolateViridis;
}

/** A stable color for a category beyond the palettes: hue from a hash, fixed chroma and lightness. */
export function hashedCategoryColor(category: string, theme: ColorTheme): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < category.length; ++i) {
    hash ^= category.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = (hash >>> 0) % 360;
  return d3.hcl(hue, 45, theme === "dark" ? 72 : 52).formatHex();
}

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
    return d3.interpolateViridis;
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

function makeBinning(
  palette: RGB[],
  binOf: (value: DatapointValue) => number,
  legend: ColorLegend,
  theme: ColorTheme,
): ColorBinning {
  const missingBin = palette.length;
  const withMissing = [...palette, MISSING[theme]];
  const cssByAlpha = new Map<number, string[]>();
  return {
    binOf,
    palette: withMissing,
    missingBin,
    legend,
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

/**
 * Categories take palette colors in the order their axis lists them (natural
 * sort), so the legend, the axis and the colors agree. A user color given for a
 * value wins.
 */
function categoricalBinning(pd: ParamDef, theme: ColorTheme): ColorBinning {
  const userColors = new Map<string, string>();
  for (const value of pd.distinct_values) {
    const userColor = pd.colors?.[String(value)];
    if (value !== undefined && userColor !== undefined) {
      userColors.set(convert_to_categorical_input(value), userColor);
    }
  }
  const categories = Array.from(
    new Set(pd.distinct_values.map((value) => convert_to_categorical_input(value))),
  ).sort(naturalSortComparator);
  const scheme = categories.length <= OKABE_ITO.length ? OKABE_ITO : TABLEAU_10;
  const binByCategory = new Map(categories.map((category, bin) => [category, bin]));
  const palette = categories.map((category, bin) =>
    parseRGB(
      userColors.get(category) ??
        (categories.length <= TABLEAU_10.length
          ? scheme[bin]
          : hashedCategoryColor(category, theme)),
    ),
  );
  const missingBin = palette.length;
  return makeBinning(
    palette,
    (value) =>
      value === undefined
        ? missingBin
        : (binByCategory.get(convert_to_categorical_input(value)) ?? missingBin),
    { kind: "categorical", categories },
    theme,
  );
}

function numericBinning(pd: ParamDef, colormap: string | null, theme: ColorTheme): ColorBinning {
  const name = pd.colormap ?? colormap;
  const colorMap = name
    ? parseColorMap(name, pd.colormap ? `for column ${pd.name}` : "(global default color map)")
    : defaultColorMap(theme);
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
  const domain = scale.kind === "continuous" ? scale.domain() : [0, 1];
  return makeBinning(
    palette,
    (value) => {
      if (value === undefined || value === null || is_special_numeric(value)) {
        return NUMERIC_COLOR_BINS;
      }
      const t = Math.max(0, Math.min(1, scale(value)));
      return Number.isNaN(t) ? NUMERIC_COLOR_BINS : Math.round(t * (NUMERIC_COLOR_BINS - 1));
    },
    { kind: "numeric", domain: [domain[0], domain[domain.length - 1]] },
    theme,
  );
}

/**
 * Builds the color bins of a color-by column. `colormap` is the experiment's
 * color map; null selects viridis.
 */
export function colorBinning(
  pd: ParamDef,
  colormap: string | null,
  theme: ColorTheme = "light",
): ColorBinning {
  return pd.type === ParamType.CATEGORICAL
    ? categoricalBinning(pd, theme)
    : numericBinning(pd, colormap, theme);
}
