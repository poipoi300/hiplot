/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";

// A hyphen-minus, so copied cells paste as numbers.
const locale = d3.formatLocale({
  decimal: ".",
  thousands: "",
  grouping: [3],
  currency: ["", ""],
  minus: "-",
});
const fixed = locale.format(".6~g");
const exponent = locale.format(".5~e");

/**
 * A number as the table shows it: integers whole, others to six significant
 * digits, in exponent notation below 1e-4 or from 1e15. The exact value stays
 * available for sorting, searching and the cell's tooltip.
 */
export function formatTableNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (Number.isInteger(value) && magnitude < 1e15) {
    return String(value);
  }
  return (magnitude !== 0 && magnitude < 1e-4) || magnitude >= 1e15
    ? exponent(value)
    : fixed(value);
}
