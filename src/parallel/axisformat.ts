/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type { ParamScale } from "../infertypes";
import { getLogScaleTickValues } from "../lib/d3_scales";
import { ParamType } from "../types";

/** A tick value on a column axis: a number, or a category. */
export type AxisValue = number | string;

/** Vertical pixels per tick: few enough that labels never crowd. */
const PIXELS_PER_TICK = 90;
/** Smallest gap between category labels before some are skipped. */
const PIXELS_PER_CATEGORY = 14;
/** Label of the band holding inf, NaN and missing values. */
export const OUTLIER_TICK_LABEL = "nan/inf/null";

const formatSI = d3.format("~s");

/** A power of ten, written out between 0.01 and 1000 and as 1eN beyond. */
export function formatPowerOfTen(value: number): string {
  const exponent = Math.round(Math.log10(value));
  if (exponent >= -2 && exponent <= 3) {
    return d3.format("~r")(10 ** exponent);
  }
  return `1e${exponent}`;
}

/** A full date and time, for values picked out of a timestamp axis (brush ends). */
export function formatTimestamp(seconds: number): string {
  return d3.timeFormat("%Y-%m-%d %H:%M")(new Date(seconds * 1000));
}

export function tickCountFor(axisHeight: number): number {
  return Math.max(2, Math.round(axisHeight / PIXELS_PER_TICK));
}

/** Formats values of a continuous axis: SI prefixes for large magnitudes, plain otherwise. */
export function valueFormatter(scale: ParamScale, tickCount: number): (value: number) => string {
  if (scale.kind !== "continuous") {
    return (value) => String(value);
  }
  if (scale.paramType === ParamType.NUMERICLOG) {
    const base = d3.format("~r");
    return (value) =>
      Number.isNaN(value) ? OUTLIER_TICK_LABEL : base(Number(value.toPrecision(3)));
  }
  const fallback = scale.tickFormat(tickCount);
  if (scale.paramType === ParamType.NUMERICPERCENTILE) {
    const compact = d3.format(".3~g");
    return (value) => (Number.isNaN(value) ? OUTLIER_TICK_LABEL : compact(value));
  }
  if (scale.paramType !== ParamType.NUMERIC) {
    return fallback;
  }
  const largest = Math.max(...scale.domain().map((v) => Math.abs(v)));
  return largest >= 1e4
    ? (value) => (Number.isNaN(value) ? OUTLIER_TICK_LABEL : formatSI(value))
    : fallback;
}

/** The left axis of one column: tick count from its height, compact labels. */
export function columnAxis(scale: ParamScale, axisHeight: number): d3.Axis<AxisValue> {
  const tickCount = tickCountFor(axisHeight);
  const axis = d3.axisLeft<AxisValue>(scale).tickSizeOuter(0);
  if (scale.kind === "categorical") {
    const categories = scale.domain();
    const step = Math.max(1, Math.ceil((categories.length * PIXELS_PER_CATEGORY) / axisHeight));
    return axis.tickValues(categories.filter((_, index) => index % step === 0));
  }
  const format = valueFormatter(scale, tickCount);
  const formatTick = (value: AxisValue): string =>
    typeof value === "number" ? format(value) : value;
  if (scale.paramType === ParamType.NUMERICLOG) {
    const powers = getLogScaleTickValues(scale.domain(), tickCount);
    if (powers !== null) {
      const values: AxisValue[] = scale.hasOutlierBand ? [...powers, Number.NaN] : powers;
      return axis
        .tickValues(values)
        .tickFormat((value) =>
          typeof value === "number" && !Number.isNaN(value)
            ? formatPowerOfTen(value)
            : OUTLIER_TICK_LABEL,
        );
    }
  }
  if (scale.paramType === ParamType.NUMERICLOG) {
    // Less than two decades: d3's log ticks list every integer multiple, so thin them.
    const candidates = scale.ticks(tickCount);
    const step = Math.max(1, Math.ceil(candidates.length / (tickCount + 1)));
    return axis
      .tickValues(candidates.filter((_, index) => index % step === 0))
      .tickFormat(formatTick);
  }
  return axis.ticks(tickCount).tickFormat(formatTick);
}
