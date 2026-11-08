/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type { ParamScale } from "../infertypes";
import { getLogScaleTickValues } from "../lib/d3_scales";
import { columnNotation, formatterFor, powerOfTenLabels, tickNotation } from "../lib/numberformat";
import { ParamType } from "../types";

/** A tick value on a column axis: a number, or a category. */
export type AxisValue = number | string;

/** Vertical pixels per tick: few enough that labels never crowd. */
const PIXELS_PER_TICK = 90;
/** Smallest gap between category labels before some are skipped. */
const PIXELS_PER_CATEGORY = 14;
/** Label of the band holding inf, NaN and missing values. */
export const OUTLIER_TICK_LABEL = "nan/inf/null";

/** A full date and time, for values picked out of a timestamp axis (brush ends). */
export function formatTimestamp(seconds: number): string {
  return d3.timeFormat("%Y-%m-%d %H:%M")(new Date(seconds * 1000));
}

export function tickCountFor(axisHeight: number): number {
  return Math.max(2, Math.round(axisHeight / PIXELS_PER_TICK));
}

/** `format`, writing NaN (the outlier band) as its label. */
const withOutlierBand =
  (format: (value: number) => string) =>
  (value: number): string =>
    Number.isNaN(value) ? OUTLIER_TICK_LABEL : format(value);

/**
 * Formats values of a continuous axis in one notation for the whole axis
 * (see `tickNotation`): its ticks, and values picked out of it such as
 * brush ends. Log axes read their notation from the domain, as their ticks
 * are powers of ten (see `columnAxis`).
 */
export function valueFormatter(scale: ParamScale, tickCount: number): (value: number) => string {
  if (scale.kind !== "continuous") {
    return (value) => String(value);
  }
  if (scale.paramType === ParamType.TIMESTAMP) {
    return scale.tickFormat(tickCount);
  }
  if (scale.paramType === ParamType.NUMERICLOG) {
    return withOutlierBand(formatterFor(columnNotation(scale.domain())));
  }
  return withOutlierBand(formatterFor(tickNotation(scale.ticks(tickCount))));
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
      const powerLabels = powerOfTenLabels(powers);
      const labels = new Map(powers.map((power, index) => [power, powerLabels[index]]));
      return axis
        .tickValues(values)
        .tickFormat((value) =>
          typeof value === "number" && !Number.isNaN(value)
            ? (labels.get(value) ?? String(value))
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
