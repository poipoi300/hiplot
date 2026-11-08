/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type { DatapointValue } from "../types";

/** What a scale accepts: a raw cell value, or a Date for timestamp axes. */
export type ScaleInput = DatapointValue | Date;

interface ScaleBase {
  /** Pixel position of a value; NaN when the value has no position on this scale. */
  (value: ScaleInput): number;
  range(): [number, number];
  range(range: readonly [number, number]): this;
  copy(): this;
}

/** Evenly spaced positions for the sorted distinct values of a categorical column. */
export interface CategoricalScale extends ScaleBase {
  readonly kind: "categorical";
  domain(): string[];
}

/** A numeric axis: linear, log, percentile or timestamp, optionally with an inf/NaN band. */
export interface ContinuousScale extends ScaleBase {
  readonly kind: "continuous";
  domain(): number[];
  domain(domain: readonly number[]): this;
  invert(pixel: number): number;
  ticks(count?: number): number[];
  tickFormat(count?: number, specifier?: string): (value: number) => string;
  /** True when a band at the end of the range holds inf, NaN and missing values. */
  readonly hasOutlierBand: boolean;
}

export type Scale = CategoricalScale | ContinuousScale;

/*
 * How numbers are spelled in text cells, as CSV files carry them. The same
 * grammar types CSV columns in Python (`hiplot/csvvalues.py`), so a column is
 * numeric on both sides or on neither.
 */
const FINITE_SPELLING = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INFINITE_SPELLING = /^([+-]?)(?:inf|infinity)$/i;
const NAN_SPELLING = /^[+-]?nan$/i;

/**
 * Whether a text cell spells a value with no finite number: inf, infinity or
 * nan in any case and with an optional sign, or blank (a missing value).
 */
function isSpecialSpelling(text: string): boolean {
  return text === "" || INFINITE_SPELLING.test(text) || NAN_SPELLING.test(text);
}

/** inf, -inf, NaN, null and blank, as numbers or as the text CSV gives. */
export function is_special_numeric(x: unknown): boolean {
  switch (typeof x) {
    case "number":
      return !Number.isFinite(x);
    case "string":
      return isSpecialSpelling(x.trim());
    case "object":
      return x === null;
    default:
      return false;
  }
}

/** Whether a cell can sit on a numeric axis: a number, a number spelled as text, or a special. */
export function is_numeric_value(x: unknown): boolean {
  if (typeof x === "string") {
    const text = x.trim();
    return FINITE_SPELLING.test(text) || isSpecialSpelling(text);
  }
  return typeof x === "number" || x === null;
}

/**
 * The number a cell holds: numbers as they are, text by the spellings above
 * (inf and infinity give ±Infinity), and NaN for anything holding no number.
 */
export function parse_numeric(x: unknown): number {
  if (typeof x === "number") {
    return x;
  }
  if (typeof x !== "string") {
    return Number.NaN;
  }
  const text = x.trim();
  if (FINITE_SPELLING.test(text)) {
    return Number(text);
  }
  const infinite = INFINITE_SPELLING.exec(text);
  if (infinite === null) {
    return Number.NaN;
  }
  return infinite[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

/** The number a scale places: a cell's number, or the milliseconds of a Date. */
function toNumber(value: ScaleInput): number {
  return value instanceof Date ? value.getTime() : parse_numeric(value);
}

function toPrecisionFloor(v: number, p: number): number {
  if (v < 0) {
    return -toPrecisionFloor(-v, p);
  } else if (v === 0) {
    return 0;
  }
  const pow = 10 ** (p - 1 - Math.floor(Math.log10(v)));
  return Math.floor(v * pow) / pow;
}

export function convert_to_categorical_input(v: ScaleInput): string {
  if (v === "") {
    return "(empty)";
  }
  return `${v}`;
}

// Natural sort comparator that handles numeric strings correctly
// e.g., "1", "2", "10" instead of "1", "10", "2"
export function naturalSortComparator(a: string, b: string): number {
  // Split strings into segments of numbers and non-numbers
  const segmentA = a.match(/(\d+|\D+)/g) || [];
  const segmentB = b.match(/(\d+|\D+)/g) || [];

  const maxLen = Math.max(segmentA.length, segmentB.length);
  for (let i = 0; i < maxLen; i++) {
    const partA = segmentA[i] || "";
    const partB = segmentB[i] || "";

    const numA = parseInt(partA, 10);
    const numB = parseInt(partB, 10);

    // Both are numbers - compare numerically
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) {
        return numA - numB;
      }
    } else if (partA !== partB) {
      // At least one is not a number - compare as strings
      return partA.localeCompare(partB);
    }
  }
  return 0;
}

function categoricalFromPoint(point: d3.ScalePoint<string>): CategoricalScale {
  const scale = (value: ScaleInput): number => point(convert_to_categorical_input(value)) ?? NaN;
  function range(): [number, number];
  function range(newRange: readonly [number, number]): CategoricalScale;
  function range(newRange?: readonly [number, number]): [number, number] | CategoricalScale {
    if (newRange === undefined) {
      return point.range();
    }
    point.range(newRange);
    return categorical;
  }
  const categorical: CategoricalScale = Object.assign(scale, {
    kind: "categorical" as const,
    domain: () => point.domain(),
    range,
    copy: () => categoricalFromPoint(point.copy()),
  });
  return categorical;
}

export function d3_scale_categorical(distinct_values: Iterable<ScaleInput>): CategoricalScale {
  const domain = Array.from(new Set(Array.from(distinct_values, convert_to_categorical_input)));
  domain.sort(naturalSortComparator);
  return categoricalFromPoint(d3.scalePoint<string>().domain(domain));
}

export function get_numeric_values_sorted(values: Iterable<ScaleInput>): Array<number> {
  const numbers = Array.from(values, toNumber).filter((x) => Number.isFinite(x));
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

interface ContinuousMethods {
  domain(): number[];
  setDomain(domain: readonly number[]): void;
  range(): [number, number];
  setRange(range: readonly [number, number]): void;
  invert(pixel: number): number;
  ticks(count?: number): number[];
  tickFormat(count?: number, specifier?: string): (value: number) => string;
  copy(): ContinuousScale;
  hasOutlierBand: boolean;
}

/** Assembles a ContinuousScale from a mapping function and its methods. */
function makeContinuous(
  map: (value: ScaleInput) => number,
  methods: ContinuousMethods,
): ContinuousScale {
  function range(): [number, number];
  function range(newRange: readonly [number, number]): ContinuousScale;
  function range(newRange?: readonly [number, number]): [number, number] | ContinuousScale {
    if (newRange === undefined) {
      return methods.range();
    }
    methods.setRange(newRange);
    return continuous;
  }
  function domain(): number[];
  function domain(newDomain: readonly number[]): ContinuousScale;
  function domain(newDomain?: readonly number[]): number[] | ContinuousScale {
    if (newDomain === undefined) {
      return methods.domain();
    }
    methods.setDomain(newDomain);
    return continuous;
  }
  const continuous: ContinuousScale = Object.assign((value: ScaleInput) => map(value), {
    kind: "continuous" as const,
    range,
    domain,
    invert: methods.invert,
    ticks: methods.ticks,
    tickFormat: methods.tickFormat,
    copy: methods.copy,
    hasOutlierBand: methods.hasOutlierBand,
  });
  return continuous;
}

/** Wraps a d3 linear or log scale. */
export function continuousFromD3(
  numeric: d3.ScaleLinear<number, number> | d3.ScaleLogarithmic<number, number>,
): ContinuousScale {
  return makeContinuous((value) => numeric(toNumber(value)), {
    domain: () => numeric.domain(),
    setDomain: (domain) => {
      numeric.domain(domain);
    },
    range: () => numeric.range() as [number, number],
    setRange: (range) => {
      numeric.range(range);
    },
    invert: (pixel) => numeric.invert(pixel),
    ticks: (count) => numeric.ticks(count),
    tickFormat: (count, specifier) => numeric.tickFormat(count, specifier),
    copy: () => continuousFromD3(numeric.copy()),
    hasOutlierBand: false,
  });
}

/**
 * Creates a quantile scale for d3js.
 * maps a point to its quantile (from 0 to 1)
 * .. and handles ticks correctly (unlike d3.scaleQuantile)
 */
export function d3_scale_percentile(values: Iterable<ScaleInput>): ContinuousScale {
  return d3_scale_percentile_values_sorted(get_numeric_values_sorted(values));
}

export function d3_scale_percentile_values_sorted(
  values: Array<number>,
  initialDomainIdx: readonly [number, number] = [0, values.length - 1],
): ContinuousScale {
  console.assert(values.length >= 2);
  let domain_idx: [number, number] = [initialDomainIdx[0], initialDomainIdx[1]];
  const scaleOutput = d3.scaleLinear().domain([0, 1]);
  const map = (value: ScaleInput): number => {
    const x = toNumber(value);
    if (x === Infinity || x === -Infinity || Number.isNaN(x)) {
      return scaleOutput(-1);
    }
    if (x > values[domain_idx[1]]) {
      return scaleOutput(1.0);
    } else if (x < values[domain_idx[0]]) {
      return scaleOutput(0.0);
    }
    const upper = d3.bisectLeft(values, x, domain_idx[0], domain_idx[1]);
    let pctile = (upper - domain_idx[0]) / (domain_idx[1] - domain_idx[0]);
    if (values[upper] !== x && upper > domain_idx[0]) {
      // For example when rendering axis ticks
      const lower = upper - 1;
      const lowerV = values[lower];
      const upperV = values[upper];
      const a = (x - lowerV) / (upperV - lowerV);
      pctile = (lower + a) / (domain_idx[1] - domain_idx[0]);
    }
    return scaleOutput(pctile);
  };
  function invert(pixel: number): number {
    let y = scaleOutput.invert(pixel) * (domain_idx[1] - domain_idx[0]);
    y = Math.min(y, domain_idx[1]);
    y = Math.max(y, domain_idx[0]);
    const lower = Math.floor(y);
    const upper = Math.ceil(y);
    if (lower === upper) {
      return values[lower];
    }
    const a = y - lower;
    return values[upper] * a + values[lower] * (1 - a);
  }
  function setDomain(d: readonly number[]): void {
    domain_idx = [d3.bisect(values, d[0]), d3.bisect(values, d[1])];
    if (domain_idx[0] === domain_idx[1]) {
      domain_idx[0] -= 1;
      domain_idx[1] += 1;
    }
    domain_idx[0] = Math.max(domain_idx[0], 0);
    domain_idx[1] = Math.min(domain_idx[1], values.length - 1);
  }
  function ticks(count = 10): number[] {
    if (count >= domain_idx[1] - domain_idx[0] + 1) {
      return values.slice(domain_idx[0], domain_idx[1] + 1);
    }
    const t: number[] = [];
    for (let i = 0; i < count; ++i) {
      // Find the roundest number in the interval
      const start_idx = domain_idx[0] + Math.floor((i / count) * (domain_idx[1] - domain_idx[0]));
      const end_dx =
        domain_idx[0] + Math.floor(((i + 1) / count) * (domain_idx[1] - domain_idx[0]));
      const start = values[start_idx];
      const end = end_dx > domain_idx[1] ? values[domain_idx[1]] : values[end_dx];
      let val: number;
      if (start === end) {
        val = start;
      } else {
        let precision = 1;
        const prev = i > 0 ? t[t.length - 1] : start;
        while (
          precision < 20 &&
          toPrecisionFloor(prev, precision) === toPrecisionFloor(end, precision)
        ) {
          ++precision;
        }
        val = parseFloat(((prev + end) / 2).toPrecision(precision));
      }
      if (i > 0 && t[i - 1] === val) {
        continue;
      }
      t.push(val);
    }
    return t;
  }
  function tickFormat(): (value: number) => string {
    return (val: number): string => {
      let precision = 1;
      while (precision < 20 && parseFloat(val.toPrecision(precision)) !== val) {
        ++precision;
      }
      return val.toPrecision(precision);
    };
  }
  return makeContinuous(map, {
    domain: () => [values[domain_idx[0]], values[domain_idx[1]]],
    setDomain,
    range: () => scaleOutput.range() as [number, number],
    setRange: (range) => {
      scaleOutput.range(range);
    },
    invert,
    ticks,
    tickFormat,
    copy: () =>
      d3_scale_percentile_values_sorted(values, domain_idx).range(
        scaleOutput.range() as [number, number],
      ),
    hasOutlierBand: false,
  });
}

/**
 * Generate tick values restricted to powers of 10 for log scales.
 * Thins out ticks if there are more than fit in the available space.
 */
export function getLogScaleTickValues(domain: number[], approxTickCount: number): number[] | null {
  if (!Array.isArray(domain) || domain.length < 2) {
    return null;
  }
  const dMin = Number(domain[0]);
  const dMax = Number(domain[domain.length - 1]);
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax) || dMin <= 0 || dMax <= 0) {
    return null;
  }
  // Use ceil/floor to keep ticks within the domain, preventing labels
  // from bleeding outside the chart area (especially on the distribution plot).
  const minExp = Math.ceil(Math.log10(dMin));
  const maxExp = Math.floor(Math.log10(dMax));
  const majorTicks: number[] = [];
  for (let exp = minExp; exp <= maxExp; exp++) {
    majorTicks.push(10 ** exp);
  }
  if (majorTicks.length > approxTickCount && majorTicks.length > 2) {
    const step = Math.ceil(majorTicks.length / approxTickCount);
    const thinned: number[] = [majorTicks[0]];
    for (let i = step; i < majorTicks.length - 1; i += step) {
      thinned.push(majorTicks[i]);
    }
    thinned.push(majorTicks[majorTicks.length - 1]);
    return thinned;
  }
  return majorTicks.length > 1 ? majorTicks : null;
}

/** The size of the band holding inf, NaN and missing values, at the end of the range. */
export const OUTLIER_BAND_PIXELS = 30;

/**
 * Adds NaN/Inf/-Inf to a continuous scale, with one extra tick for them.
 *
 * Either the scale is in ascending order (range[1] > range[0]):
 *      [ original scale values ] [inf / nan]
 *      ^                        ^
 *    range[0]            range[0]+origin_scale_size
 * or it is not, and the values are:
 *      [inf / nan] | [ original scale values ]
 *      ^           ^                          ^
 *    range[1]  range[0]-origin_scale_size   range[0]
 */
export function scale_add_outliers(scale_orig: ContinuousScale): ContinuousScale {
  const origin_scale_size = (): number => {
    const range = scale_orig.range();
    return Math.abs(range[1] - range[0]) - OUTLIER_BAND_PIXELS;
  };
  const map = (x: ScaleInput): number => {
    const range = scale_orig.range();
    if (is_special_numeric(x)) {
      return range[1];
    }
    const ascending_order = range[0] < range[1];
    const scale_orig_value_rel =
      ((scale_orig(x) - range[0]) / (range[1] - range[0])) * origin_scale_size();
    return ascending_order ? range[0] + scale_orig_value_rel : range[0] - scale_orig_value_rel;
  };
  function invert(pixel: number): number {
    const domain = scale_orig.domain();
    const range = scale_orig.range();
    const size = origin_scale_size();
    let y = pixel;
    if (range[0] < range[1]) {
      if (y > range[0] + size) {
        // Infinite domain
        return domain[1] * 1.1;
      }
      y -= range[0];
    } else {
      if (y < range[0] - size) {
        // Infinite domain
        return domain[1] * 1.1;
      }
      y = -y + range[0];
    }
    y = (y / size) * (range[1] - range[0]);
    y += range[0];
    return scale_orig.invert(y);
  }
  return makeContinuous(map, {
    domain: () => scale_orig.domain(),
    setDomain: (domain) => {
      scale_orig.domain(domain);
    },
    range: () => scale_orig.range(),
    setRange: (range) => {
      scale_orig.range(range);
    },
    invert,
    // One tick fewer than asked for, plus the NaN tick for the outlier band.
    ticks: (count) => [
      ...(count === undefined ? scale_orig.ticks() : scale_orig.ticks(count - 1)),
      NaN,
    ],
    tickFormat: (count) => {
      const format = scale_orig.tickFormat(count);
      return (x: number) => (Number.isNaN(x) ? "nan/inf/null" : format(x));
    },
    copy: () => scale_add_outliers(scale_orig.copy()),
    hasOutlierBand: true,
  });
}

/**
 * Timestamps in seconds on a d3 time scale (which works in milliseconds).
 * Domain, ticks and inverted values are all in seconds.
 */
export function d3_scale_timestamp(
  time: d3.ScaleTime<number, number> = d3.scaleTime(),
): ContinuousScale {
  const toDate = (timestamp: ScaleInput): Date =>
    timestamp instanceof Date ? timestamp : new Date(toNumber(timestamp) * 1000);
  const toSeconds = (date: Date): number => date.getTime() / 1000;
  return makeContinuous((value) => time(toDate(value)), {
    domain: () => time.domain().map(toSeconds),
    setDomain: (domain) => {
      time.domain(domain.map((seconds) => toDate(seconds)));
    },
    range: () => time.range() as [number, number],
    setRange: (range) => {
      time.range(range);
    },
    invert: (pixel) => toSeconds(time.invert(pixel)),
    ticks: (count) => time.ticks(count ?? 10).map(toSeconds),
    tickFormat: (count) => {
      const format = time.tickFormat(count);
      return (seconds: number) => format(toDate(seconds));
    },
    copy: () => d3_scale_timestamp(time.copy()),
    hasOutlierBand: false,
  });
}
