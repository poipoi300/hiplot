/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import { create_d3_scale, type ParamDef, type ParamScale } from "../infertypes";
import { getLogScaleTickValues } from "../lib/d3_scales";
import {
  columnNotation,
  formatterFor,
  powerOfTenFormatter,
  powerOfTenLabels,
  powersWrittenOut,
  tickNotation,
  ticksNeedScientific,
} from "../lib/numberformat";
import { ParamType } from "../types";

/** A tick value on a column axis: a number, or a category. */
export type AxisValue = number | string;

/** Vertical pixels per tick: few enough that labels never crowd. */
const PIXELS_PER_TICK = 90;
/** Smallest gap between category labels before some are skipped. */
const PIXELS_PER_CATEGORY = 14;
/** Label of the band holding inf, NaN and missing values. */
export const OUTLIER_TICK_LABEL = "nan/inf/null";
/** Significant digits of values written between the powers of ten of a log axis. */
const LOG_VALUE_DIGITS = 2;

/** A full date and time, for values picked out of a timestamp axis (brush ends). */
export function formatTimestamp(seconds: number): string {
  return d3.timeFormat("%Y-%m-%d %H:%M")(new Date(seconds * 1000));
}

export function tickCountFor(axisHeight: number): number {
  return Math.max(2, Math.round(axisHeight / PIXELS_PER_TICK));
}

/**
 * How an axis writes its numbers. Decided once from every row of its column
 * (see `columnAxisStyle`), so that Keep and Exclude, which rescale the axis
 * to the rows left, never switch it to another notation.
 */
export interface AxisStyle {
  /**
   * Linear and percentile axes: scientific notation rather than fixed. Log
   * axes: powers of ten as 10ⁿ rather than written out (0.01 to 1000).
   */
  scientific: boolean;
}

/** The style that suits an axis drawn with `scale` and `tickCount` ticks. */
export function axisStyle(scale: ParamScale, tickCount: number): AxisStyle {
  if (scale.kind !== "continuous" || scale.paramType === ParamType.TIMESTAMP) {
    return { scientific: false };
  }
  if (scale.paramType === ParamType.NUMERICLOG) {
    const powers = getLogScaleTickValues(scale.domain(), tickCount);
    return {
      scientific:
        powers === null
          ? columnNotation(scale.domain()).kind === "scientific"
          : !powersWrittenOut(powers),
    };
  }
  return { scientific: ticksNeedScientific(scale.ticks(tickCount)) };
}

const columnStyles = new WeakMap<ParamDef, Map<string, AxisStyle>>();

/**
 * The style of an axis showing `column` as `type`: `column` describes every
 * row of the experiment (`params_def_unfiltered`). Cached per column
 * definition, which is replaced whenever the experiment's rows change.
 */
export function columnAxisStyle(column: ParamDef, type: ParamType, tickCount: number): AxisStyle {
  let styles = columnStyles.get(column);
  if (styles === undefined) {
    styles = new Map();
    columnStyles.set(column, styles);
  }
  const key = `${type}:${tickCount}`;
  const cached = styles.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const style = axisStyle(create_d3_scale({ ...column, type }), tickCount);
  styles.set(key, style);
  return style;
}

/** `format`, writing NaN (the outlier band) as its label. */
const withOutlierBand =
  (format: (value: number) => string) =>
  (value: number): string =>
    Number.isNaN(value) ? OUTLIER_TICK_LABEL : format(value);

/**
 * Formats values of a continuous axis in the notation of its ticks: the
 * ticks themselves, and values picked out of the axis such as brush ends.
 * Log axes whose ticks read 10ⁿ write values as 1.8×10⁻²; other log axes
 * and linear axes write them as their ticks are written.
 */
export function valueFormatter(
  scale: ParamScale,
  tickCount: number,
  style: AxisStyle,
): (value: number) => string {
  if (scale.kind !== "continuous") {
    return (value) => String(value);
  }
  if (scale.paramType === ParamType.TIMESTAMP) {
    return scale.tickFormat(tickCount);
  }
  if (scale.paramType === ParamType.NUMERICLOG) {
    return withOutlierBand(
      style.scientific
        ? powerOfTenFormatter(LOG_VALUE_DIGITS)
        : formatterFor(columnNotation(scale.domain())),
    );
  }
  return withOutlierBand(formatterFor(tickNotation(scale.ticks(tickCount), style.scientific)));
}

/** The left axis of one column: tick count from its height, labels in the axis's style. */
export function columnAxis(
  scale: ParamScale,
  axisHeight: number,
  style: AxisStyle,
): d3.Axis<AxisValue> {
  const tickCount = tickCountFor(axisHeight);
  const axis = d3.axisLeft<AxisValue>(scale).tickSizeOuter(0);
  if (scale.kind === "categorical") {
    const categories = scale.domain();
    const step = Math.max(1, Math.ceil((categories.length * PIXELS_PER_CATEGORY) / axisHeight));
    return axis.tickValues(categories.filter((_, index) => index % step === 0));
  }
  const format = valueFormatter(scale, tickCount, style);
  const formatTick = (value: AxisValue): string =>
    typeof value === "number" ? format(value) : value;
  if (scale.paramType === ParamType.NUMERICLOG) {
    const powers = getLogScaleTickValues(scale.domain(), tickCount);
    if (powers !== null) {
      const values: AxisValue[] = scale.hasOutlierBand ? [...powers, Number.NaN] : powers;
      const powerLabels = powerOfTenLabels(powers, !style.scientific);
      const labels = new Map(powers.map((power, index) => [power, powerLabels[index]]));
      return axis
        .tickValues(values)
        .tickFormat((value) =>
          typeof value === "number" && !Number.isNaN(value)
            ? (labels.get(value) ?? String(value))
            : OUTLIER_TICK_LABEL,
        );
    }
    // Less than two decades: d3's log ticks list every integer multiple, so thin them.
    const candidates = scale.ticks(tickCount);
    const step = Math.max(1, Math.ceil(candidates.length / (tickCount + 1)));
    return axis
      .tickValues(candidates.filter((_, index) => index % step === 0))
      .tickFormat(formatTick);
  }
  return axis.ticks(tickCount).tickFormat(formatTick);
}
