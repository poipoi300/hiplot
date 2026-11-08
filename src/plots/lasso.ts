/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** A point on screen, in CSS pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Fewer points than this make no area to select: the gesture was a click. */
export const MIN_LASSO_POINTS = 3;

/** Whether (x, y) lies inside `polygon` (even-odd rule; the polygon closes itself). */
export function insidePolygon(x: number, y: number, polygon: ReadonlyArray<ScreenPoint>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Indices, among `count` points, of those whose screen position falls inside
 * the lasso. `project` gives a point's screen position, or null when it is
 * not on screen (behind the camera, or a missing value).
 */
export function lassoed(
  count: number,
  project: (index: number) => ScreenPoint | null,
  polygon: ReadonlyArray<ScreenPoint>,
): number[] {
  if (polygon.length < MIN_LASSO_POINTS) {
    return [];
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { x, y } of polygon) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const inside: number[] = [];
  for (let index = 0; index < count; ++index) {
    const point = project(index);
    if (
      point !== null &&
      point.x >= left &&
      point.x <= right &&
      point.y >= top &&
      point.y <= bottom &&
      insidePolygon(point.x, point.y, polygon)
    ) {
      inside.push(index);
    }
  }
  return inside;
}

/** Wheel events further apart than this start a new gesture. */
export const WHEEL_GESTURE_GAP_MS = 250;

/**
 * Remembers where each wheel gesture started, so a plot only takes over the
 * gestures that started on it: a page scroll that passes over the plot keeps
 * scrolling the page.
 */
export class WheelLatch {
  private startedOn: EventTarget | null = null;
  private last = Number.NEGATIVE_INFINITY;

  /** Records a wheel event; call it for every wheel event on the page, first. */
  record(target: EventTarget | null, time: number): void {
    if (time - this.last > WHEEL_GESTURE_GAP_MS) {
      this.startedOn = target;
    }
    this.last = time;
  }

  /** Whether the current gesture started inside `element`. */
  startedInside(element: Node): boolean {
    return this.startedOn instanceof Node && element.contains(this.startedOn);
  }
}
