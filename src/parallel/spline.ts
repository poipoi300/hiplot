/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The curved line shape: a monotone spline through the axes. Between two
 * axes a line is a cubic Bezier whose handles reach `SPLINE_HANDLE` of the
 * gap along the line's slope at each axis. Slopes follow Steffen's monotone
 * method (the one d3.curveMonotoneX uses): zero where the line turns, so a
 * row's value is never drawn beyond its neighbors, and the slope that keeps
 * the line flowing where it keeps rising or falling. The WebGL vertex shader
 * mirrors these functions.
 */

/** Handle length of each Bezier segment, as a fraction of the gap between its axes. */
export const SPLINE_HANDLE = 0.5;

/**
 * Slope dy/dx of the spline at an axis at (x, y), from its neighbors on the
 * previous and next axes. A missing neighbor (NaN y) or a degenerate gap
 * flattens the line, matching the horizontal stubs at the ends of a line.
 */
export function monotoneSlope(
  xPrevious: number,
  yPrevious: number,
  x: number,
  y: number,
  xNext: number,
  yNext: number,
): number {
  const before = x - xPrevious;
  const after = xNext - x;
  if (Number.isNaN(yPrevious) || Number.isNaN(y) || Number.isNaN(yNext)) {
    return 0;
  }
  if (!(before > 0 && after > 0)) {
    return 0;
  }
  const slopeBefore = (y - yPrevious) / before;
  const slopeAfter = (yNext - y) / after;
  const parabola = (slopeBefore * after + slopeAfter * before) / (before + after);
  return (
    (Math.sign(slopeBefore) + Math.sign(slopeAfter)) *
    Math.min(Math.abs(slopeBefore), Math.abs(slopeAfter), 0.5 * Math.abs(parabola))
  );
}

/** One coordinate of a cubic Bezier at parameter t. */
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Bezier parameter at which a segment reaches fraction `s` of its gap. The
 * handles are horizontal-length `SPLINE_HANDLE` whatever the slopes, so this
 * only depends on `s`: bisection on x(t) = Bezier(0, h, 1 - h, 1).
 */
export function splineParameter(s: number): number {
  const clamped = Math.max(0, Math.min(1, s));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; ++i) {
    const middle = (low + high) / 2;
    if (bezier(0, SPLINE_HANDLE, 1 - SPLINE_HANDLE, 1, middle) < clamped) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

/** Height of a spline segment at parameter t, between (0, yLeft) and (gap, yRight). */
export function splineY(
  t: number,
  gap: number,
  yLeft: number,
  slopeLeft: number,
  yRight: number,
  slopeRight: number,
): number {
  const handle = SPLINE_HANDLE * gap;
  return bezier(yLeft, yLeft + handle * slopeLeft, yRight - handle * slopeRight, yRight, t);
}
