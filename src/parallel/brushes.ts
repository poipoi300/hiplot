/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { ScaleDomainRange } from "../infertypes";
import { OUTLIER_BAND_PIXELS, type Scale } from "../lib/d3_scales";
import { isStringArray } from "../lib/savedstate";
import { ParamType } from "../types";

/**
 * An interval along an axis, as positions along its scale's range: 0 at
 * `range()[0]` (the bottom of an upright axis), 1 at `range()[1]`. Positions
 * follow the values, so an interval survives resizing and inverting the axis.
 */
export interface AxisInterval {
  start: number;
  end: number;
}

/** One brush on an axis; `start < end`. The id keys its DOM and its gestures. */
export interface AxisBrush extends AxisInterval {
  id: number;
}

/** A vertical span in pixels, `top < bottom`. */
export interface PixelSpan {
  top: number;
  bottom: number;
}

/** The pixel span of an interval on an axis whose scale has `range`. */
export function intervalPixels(
  range: readonly [number, number],
  interval: AxisInterval,
): PixelSpan {
  const [from, to] = range;
  const a = from + interval.start * (to - from);
  const b = from + interval.end * (to - from);
  return { top: Math.min(a, b), bottom: Math.max(a, b) };
}

/** The interval a pixel span covers on an axis whose scale has `range`. */
export function pixelInterval(range: readonly [number, number], span: PixelSpan): AxisInterval {
  const [from, to] = range;
  const a = (span.top - from) / (to - from);
  const b = (span.bottom - from) / (to - from);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Merges the brushes that overlap or touch, `touching` apart at most, into
 * one brush each, sorted by start. A merged brush keeps the oldest (lowest)
 * id among the brushes it absorbs.
 */
export function mergeBrushes(brushes: Iterable<AxisBrush>, touching: number): AxisBrush[] {
  const sorted = Array.from(brushes).sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id - b.id,
  );
  const merged: AxisBrush[] = [];
  for (const brush of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && brush.start <= last.end + touching) {
      merged[merged.length - 1] = {
        id: Math.min(last.id, brush.id),
        start: last.start,
        end: Math.max(last.end, brush.end),
      };
      continue;
    }
    merged.push({ ...brush });
  }
  return merged;
}

/**
 * One brush saved for a reload, in data space, so that it selects the same
 * values when the rows or the axis layout changed: the values of a numeric
 * axis it covers, and whether it reaches the band of inf, NaN and missing
 * values; or the categories of a categorical axis.
 */
export type SavedBrush =
  | { categories: string[] }
  | { min: number; max: number; include_infnans: boolean };

/** A brush as earlier versions saved it: an interval of positions along the scale range. */
export type SavedPositions = [number, number];

/** Brushes saved for a reload: the brushes of each brushed axis. */
export type SavedBrushes = Record<string, Array<SavedBrush | SavedPositions>>;

/** What a brush selecting `range` saves. */
export function savedBrushOf(range: ScaleDomainRange): SavedBrush {
  if (range.type === ParamType.CATEGORICAL) {
    return { categories: range.values };
  }
  return {
    min: Math.min(...range.range),
    max: Math.max(...range.range),
    include_infnans: range.include_infnans,
  };
}

/** At most this many pixels of brush above and below a lone category. */
const CATEGORY_PADDING_PIXELS = 8;

/**
 * The intervals a saved brush covers on an axis drawn with `scale`. A
 * numeric range is clamped to the axis's domain and extended over the
 * outlier band when it includes inf and NaN; a brush on the band alone
 * covers its outer half. Categories missing from the axis are dropped, and
 * the others give one interval per run of neighbors, padded (by less than
 * half the gap to the next category) so that a lone category is brushable.
 */
export function savedBrushIntervals(scale: Scale, saved: SavedBrush): AxisInterval[] {
  const range = scale.range();
  const toInterval = (a: number, b: number): AxisInterval =>
    pixelInterval(range, { top: Math.min(a, b), bottom: Math.max(a, b) });
  if ("categories" in saved) {
    if (scale.kind !== "categorical") {
      return [];
    }
    const domain = scale.domain();
    const indices = saved.categories
      .map((category) => domain.indexOf(category))
      .filter((index) => index !== -1)
      .sort((a, b) => a - b);
    const gap = domain.length > 1 ? Math.abs(range[1] - range[0]) / (domain.length - 1) : Infinity;
    const padding = Math.min(CATEGORY_PADDING_PIXELS, 0.4 * gap);
    const [low, high] = [Math.min(...range), Math.max(...range)];
    const intervals: AxisInterval[] = [];
    let first = 0;
    indices.forEach((index, position) => {
      if (position + 1 < indices.length && indices[position + 1] === index + 1) {
        return;
      }
      const ends = [scale(domain[indices[first]]), scale(domain[index])];
      const top = Math.max(low, Math.min(...ends) - padding);
      const bottom = Math.min(high, Math.max(...ends) + padding);
      intervals.push(toInterval(top, bottom));
      first = position + 1;
    });
    return intervals;
  }
  if (scale.kind !== "continuous") {
    return [];
  }
  const domain = scale.domain();
  const lowest = Math.max(saved.min, Math.min(...domain));
  const highest = Math.min(saved.max, Math.max(...domain));
  const band = saved.include_infnans && scale.hasOutlierBand;
  if (lowest <= highest) {
    const ends = [scale(lowest), scale(highest)];
    return [
      toInterval(
        Math.min(...ends, ...(band ? [range[1]] : [])),
        Math.max(...ends, ...(band ? [range[1]] : [])),
      ),
    ];
  }
  if (!band) {
    return [];
  }
  const inward = Math.sign(range[0] - range[1]);
  return [toInterval(range[1], range[1] + (inward * OUTLIER_BAND_PIXELS) / 2)];
}

const isSavedBrush = (value: unknown): value is SavedBrush => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  if ("categories" in fields) {
    return isStringArray(fields.categories);
  }
  const { min, max, include_infnans } = fields;
  return (
    typeof min === "number" &&
    typeof max === "number" &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min <= max &&
    typeof include_infnans === "boolean"
  );
};

export const isSavedPositions = (value: unknown): value is SavedPositions =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((bound) => typeof bound === "number" && Number.isFinite(bound)) &&
  0 <= value[0] &&
  value[0] < value[1] &&
  value[1] <= 1;

/** Validates brushes read back from untyped storage (the URL, a saved state). */
export function isSavedBrushes(value: unknown): value is SavedBrushes {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (brushes) =>
        Array.isArray(brushes) &&
        brushes.every((brush) => isSavedPositions(brush) || isSavedBrush(brush)),
    )
  );
}
