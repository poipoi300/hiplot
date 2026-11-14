/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { IS_MAC } from "../lib/browsercompat";

/** A point on screen, in CSS pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Fewer points than this make no area to select: the gesture was a click. */
export const MIN_LASSO_POINTS = 3;

/** Whether a press starts a lasso: a primary press with Ctrl, or Cmd on a Mac. */
export function startsLasso(press: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return press.button === 0 && (press.ctrlKey || press.metaKey);
}

/** The lasso gesture as the plots' hints name it. */
export const LASSO_GESTURE = IS_MAC ? "⌘-drag" : "Ctrl-drag";

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
 * Whether a point lies inside a lasso: within the polygon's bounds, the cheap
 * test most points fail, and then inside it. Points with a NaN coordinate are
 * outside.
 */
export function withinLasso(polygon: ReadonlyArray<ScreenPoint>): (point: ScreenPoint) => boolean {
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
  return ({ x, y }) =>
    x >= left && x <= right && y >= top && y <= bottom && insidePolygon(x, y, polygon);
}

/** The lasso's extent along one screen axis: what it spans over a plot with no other axis. */
export function lassoSpan(polygon: ReadonlyArray<ScreenPoint>, along: "x" | "y"): [number, number] {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    low = Math.min(low, point[along]);
    high = Math.max(high, point[along]);
  }
  return [low, high];
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
