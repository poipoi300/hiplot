/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

/** Brushes saved for a reload: the intervals of each brushed axis. */
export type SavedBrushes = Record<string, Array<[number, number]>>;

const isSavedInterval = (value: unknown): value is [number, number] =>
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
      (intervals) => Array.isArray(intervals) && intervals.every(isSavedInterval),
    )
  );
}
