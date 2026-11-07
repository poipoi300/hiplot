/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";

const special_numerics = ["inf", "-inf", Infinity, -Infinity, null, "", "NaN"];
export function is_special_numeric(x) {
  return special_numerics.indexOf(x) >= 0 || Number.isNaN(x);
}

interface d3ScalePercentile {
  (x: any): any;
  domain_idx: any;
  range: any;
  invert: any;
  copy: any;
  tickFormat: any;
  ticks: any;
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

export function convert_to_categorical_input(v: any): any {
  if (v === "") {
    return "(empty)";
  }
  return "" + v;
}

// Natural sort comparator that handles numeric strings correctly
// e.g., "1", "2", "10" instead of "1", "10", "2"
function naturalSortComparator(a: string, b: string): number {
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
    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) {
        return numA - numB;
      }
    } else {
      // At least one is not a number - compare as strings
      if (partA !== partB) {
        return partA.localeCompare(partB);
      }
    }
  }
  return 0;
}

export function d3_scale_categorical(distinct_values: Array<any>): d3.ScalePoint<any> {
  const valuesSet = new Set();
  for (let idx = 0; idx < distinct_values.length; ++idx) {
    valuesSet.add(convert_to_categorical_input(distinct_values[idx]));
  }
  distinct_values = Array.from(valuesSet);
  distinct_values.sort(naturalSortComparator);
  const scale = d3.scalePoint().domain(distinct_values);

  function scale_fn(x: any): number {
    return scale(convert_to_categorical_input(x));
  }
  Object.assign(scale_fn, {
    copy: scale.copy,
    range: scale.range,
    rangeRound: scale.rangeRound,
    round: scale.round,
    domain: scale.domain,
  });
  // @ts-expect-error
  return scale_fn;
}

export function get_numeric_values_sorted(values: Array<any>): Array<number> {
  values = values.map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  values = Array.from(new Set(values));
  values.sort((a, b) => parseFloat(a) - parseFloat(b));
  return values;
}

export function d3_scale_percentile(values: Array<any>): d3ScalePercentile {
  /**
   * Creates a quantile scale for d3js.
   * maps a point to its quantile (from 0 to 1)
   * .. and handles ticks correctly (unlike d3.scaleQuantile)
   */
  return d3_scale_percentile_values_sorted(get_numeric_values_sorted(values));
}

export function d3_scale_percentile_values_sorted(values: Array<number>): d3ScalePercentile {
  console.assert(values.length >= 2);
  let domain_idx = [0, values.length - 1];
  const scaleOutput = d3.scaleLinear().domain([0, 1]);
  const scale: any = (x: number): number => {
    if (x === Infinity || x === -Infinity || isNaN(x)) {
      return scaleOutput(-1);
    }
    if (x > values[domain_idx[domain_idx.length - 1]]) {
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
      console.assert(lowerV !== upperV, "values should be distinct", lowerV, upperV);
      console.assert(
        lowerV <= x && x <= upperV,
        `percentile_scale(${x}): lowerV=${lowerV}, x=${x}, upperV=${upperV}`,
        {
          x: x,
          values: values,
          lower: lower,
          domain_idx: domain_idx,
        },
      );
      const a = (x - lowerV) / (upperV - lowerV);
      pctile = (lower + a) / (domain_idx[1] - domain_idx[0]);
    }
    return scaleOutput(pctile);
  };
  function invert(y) {
    y = scaleOutput.invert(y) * (domain_idx[1] - domain_idx[0]);
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
  function range_fn(r) {
    if (r === undefined) {
      return scaleOutput.range();
    }
    scaleOutput.range(r);
    return scale;
  }
  function domain_idx_fn(new_domain_idx) {
    domain_idx = new_domain_idx;
    return scale;
  }
  function domain_fn(d) {
    if (d === undefined) {
      return [values[domain_idx[0]], values[domain_idx[1]]];
    }
    domain_idx = [d3.bisect(values, d[0]), d3.bisect(values, d[1])];
    if (domain_idx[0] === domain_idx[1]) {
      domain_idx[0] -= 1;
      domain_idx[1] += 1;
    }
    domain_idx[0] = domain_idx[0] < 0 ? 0 : domain_idx[0];
    domain_idx[1] = domain_idx[1] >= values.length ? values.length - 1 : domain_idx[1];
    return scale;
  }
  function copy() {
    const new_scale = d3_scale_percentile_values_sorted(values);
    new_scale.domain_idx(domain_idx);
    new_scale.range(scaleOutput.range());
    return new_scale;
  }
  function ticks(n: number): number[] {
    if (n >= domain_idx[1] - domain_idx[0] + 1) {
      return values.slice(domain_idx[0], domain_idx[1] + 1);
    }
    const t: number[] = [];
    for (let i = 0; i < n; ++i) {
      // Find the roundest number in the intervalle
      const start_idx = domain_idx[0] + Math.floor((i / n) * (domain_idx[1] - domain_idx[0]));
      const end_dx = domain_idx[0] + Math.floor(((i + 1) / n) * (domain_idx[1] - domain_idx[0]));
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
  function tickFormat() {
    return (val: number): string => {
      let precision = 1;
      while (precision < 20 && parseFloat(val.toPrecision(precision)) !== val) {
        ++precision;
      }
      return val.toPrecision(precision);
    };
  }
  Object.assign(scale, {
    invert: invert,
    copy: copy,
    range: range_fn,
    domain: domain_fn,
    domain_idx: domain_idx_fn,
    tickFormat: tickFormat,
    ticks: ticks,
  });

  return scale;
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

function cpy_properties(from, to) {
  for (const prop of Object.keys(from)) {
    to[prop] = from[prop];
  }
}

export function scale_add_outliers(scale_orig) {
  /**
   * This functions adds NaN/Inf/-Inf to any d3 scale.
   * One tick is added for these special values as well.
   */
  /**
   * There are 2 options:
   * -  Either the scale is in ascending order (range[1] > range[0])
   *      In that case we have
   *      [ original scale values ] [inf / nan]
   *      ^                        ^
   *      |                        |
   *    range[0]            range[0]+origin_scale_size
   * - Or we are not in ascending order, in that case the values are
   *      [inf / nan] | [ original scale values ]
   *      ^           ^                          ^
   *      |           |                          |
   *    range[1]  range[0]-origin_scale_size   range[0]
   */
  function compute_origin_scale_size() {
    const h = Math.abs(scale_orig.range()[1] - scale_orig.range()[0]);
    return h - 30;
  }
  const scale: any = (x) => {
    const range = scale_orig.range();
    const origin_scale_size = compute_origin_scale_size();
    const ascending_order = range[0] < range[1];
    if (is_special_numeric(x)) {
      return range[1];
    }
    const scale_orig_value_rel =
      ((scale_orig(x) - range[0]) / (range[1] - range[0])) * origin_scale_size;
    return ascending_order ? range[0] + scale_orig_value_rel : range[0] - scale_orig_value_rel;
  };
  function invert(y) {
    const domain = scale_orig.domain();
    const range = scale_orig.range();
    const origin_scale_size = compute_origin_scale_size();
    const ascending_order = range[0] < range[1];
    if (ascending_order) {
      if (y > range[0] + origin_scale_size) {
        // Infinite domain
        return domain[1] * 1.1;
      }
      y -= range[0];
    } else {
      if (y < range[0] - origin_scale_size) {
        // Infinite domain
        return domain[1] * 1.1;
      }
      y = -y + range[0];
    }
    y = (y / origin_scale_size) * (range[1] - range[0]);
    y += range[0];
    return scale_orig.invert(y);
  }
  cpy_properties(scale_orig, scale);

  const new_ticks = {},
    new_tickFormat = {};
  Object.assign(scale, {
    invert: invert,
    __scale_orig: scale_orig,
    ticks: new_ticks,
    tickFormat: new_tickFormat,
  });

  cpy_properties(scale_orig.ticks, new_ticks);
  cpy_properties(scale_orig.tickFormat, new_tickFormat);
  scale.ticks.apply = (scale, tickArguments_) => {
    const args = [tickArguments_[0] - 1];
    const ret = scale_orig.ticks.apply(scale_orig, args);
    ret.push(NaN);
    return ret;
  };
  scale.tickFormat.apply = (scale, tickArguments_) => {
    const args = [tickArguments_[0]];
    const fn = scale_orig.tickFormat.apply(scale_orig, args);
    return (x) => {
      if (Number.isNaN(x)) {
        return "nan/inf/null";
      }
      return fn(x);
    };
  };
  scale.range = (new_range) => {
    if (new_range === undefined) {
      return scale_orig.range();
    }
    return scale_orig.range(new_range);
  };
  scale.copy = () => scale_add_outliers(scale_orig.copy());
  return scale;
}

function wrap_scale<T, V>(
  scale_orig: any,
  domain_to_scale: (x: T) => V,
  scale_to_domain: (x: V) => T,
): any {
  const scale: any = (x: T): number => scale_orig(domain_to_scale(x));
  function domain(new_domain?: [T, T]) {
    if (new_domain === undefined) {
      const scale_domain = scale_orig.domain();
      return [scale_to_domain(scale_domain[0]), scale_to_domain(scale_domain[1])];
    }
    scale_orig.domain([domain_to_scale(new_domain[0]), domain_to_scale(new_domain[1])]);
    return scale;
  }
  function invert(y: number) {
    return scale_to_domain(scale_orig.invert(y));
  }
  function copy() {
    return wrap_scale(scale_orig.copy(), domain_to_scale, scale_to_domain);
  }
  function range() {
    const r = scale_orig.range.apply(scale_orig, arguments);
    return r === scale_orig ? scale : r;
  }

  const new_ticks = {},
    new_tickFormat = {};
  cpy_properties(scale_orig, scale);
  Object.assign(scale, {
    domain: domain,
    range: range,
    invert: invert,
    copy: copy,
    __scale_orig: scale_orig,
    ticks: new_ticks,
    tickFormat: new_tickFormat,
  });
  cpy_properties(scale_orig.ticks, new_ticks);
  cpy_properties(scale_orig.tickFormat, new_tickFormat);
  scale.ticks.apply = (_, tickArguments_) => {
    const args = [tickArguments_[0]];
    const ta = scale_orig.ticks.apply(scale_orig, args);
    return ta.map(scale_to_domain);
  };
  scale.tickFormat.apply = (_, tickArguments_) => {
    const args = [tickArguments_[0]];
    const fn = scale_orig.tickFormat.apply(scale_orig, args);
    return (x) => fn(domain_to_scale(x));
  };
  return scale;
}

export function d3_scale_timestamp() {
  // There is a trick: usually timestamps are in seconds, but JS timestamps are in ms
  function timestamp_to_jsdate(timestamp: any): Date {
    if (timestamp instanceof Date) {
      return timestamp;
    }
    return new Date(timestamp * 1000);
  }
  function jsdate_to_timestamp(date: Date): number {
    return date.getTime() / 1000;
  }
  const ts = wrap_scale(d3.scaleTime(), timestamp_to_jsdate, jsdate_to_timestamp);
  return ts;
}
