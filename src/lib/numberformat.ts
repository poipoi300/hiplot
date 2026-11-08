/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";

/**
 * How every number of one axis or table column is written. It is decided
 * once per axis or column from all of its values, so a column never mixes
 * fixed and scientific notation.
 */
export type Notation =
  | { kind: "integer" }
  | { kind: "fixed"; decimals: number }
  | { kind: "scientific"; digits: number };

/** Significant digits a value keeps in a table cell or a legend. */
const SIGNIFICANT_DIGITS = 3;
/** At most this many decimals in fixed notation. */
const MAX_DECIMALS = 6;
/**
 * Magnitudes written in fixed notation; a column with a nonzero value
 * outside them is all scientific (fixed would need more than five decimals
 * for three significant digits, or more than seven digits).
 */
const LARGEST_FIXED = 1e6;
const SMALLEST_FIXED = 1e-3;

// A hyphen-minus and no grouping, so copied cells paste as numbers.
const plainLocale = d3.formatLocale({
  decimal: ".",
  thousands: "",
  grouping: [3],
  currency: ["", ""],
  minus: "-",
});

interface Magnitudes {
  largest: number;
  /** Smallest nonzero magnitude; infinite when every value is zero. */
  smallest: number;
  allIntegers: boolean;
  any: boolean;
  anyZero: boolean;
}

function magnitudes(values: Iterable<number>): Magnitudes {
  let largest = 0;
  let smallest = Number.POSITIVE_INFINITY;
  let allIntegers = true;
  let any = false;
  let anyZero = false;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    any = true;
    const magnitude = Math.abs(value);
    largest = Math.max(largest, magnitude);
    if (magnitude > 0) {
      smallest = Math.min(smallest, magnitude);
    } else {
      anyZero = true;
    }
    allIntegers &&= Number.isInteger(value);
  }
  return { largest, smallest, allIntegers, any, anyZero };
}

/** Whether nonzero magnitudes from `smallest` to `largest` read best in scientific notation. */
function needsScientific({ largest, smallest }: Magnitudes): boolean {
  return largest >= LARGEST_FIXED || (Number.isFinite(smallest) && smallest < SMALLEST_FIXED);
}

/**
 * The notation of a column from its values: integers stay whole; nonzero
 * magnitudes within 1e-3 to 1e6 are fixed, with the decimals that give the
 * smallest one three significant digits; anything else is scientific with
 * three significant digits.
 */
export function columnNotation(values: Iterable<number>): Notation {
  return notationOf(magnitudes(values));
}

function notationOf(found: Magnitudes): Notation {
  if (!found.any || (found.allIntegers && found.largest < LARGEST_FIXED)) {
    return { kind: "integer" };
  }
  if (needsScientific(found)) {
    return { kind: "scientific", digits: SIGNIFICANT_DIGITS };
  }
  const reference = Number.isFinite(found.smallest) ? found.smallest : found.largest;
  const decimals = SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(reference));
  return { kind: "fixed", decimals: Math.max(0, Math.min(MAX_DECIMALS, decimals)) };
}

/** Whether ticks spanning these magnitudes read best in scientific notation. */
export function ticksNeedScientific(ticks: ReadonlyArray<number>): boolean {
  return needsScientific(magnitudes(ticks.filter(Number.isFinite)));
}

/**
 * The notation of an axis from its tick values: scientific when `scientific`
 * (see `ticksNeedScientific`), with the digits that keep the ticks apart,
 * else fixed with the decimals the tick step needs. A step finer than fixed
 * notation writes is scientific all the same.
 */
export function tickNotation(ticks: ReadonlyArray<number>, scientific: boolean): Notation {
  const finite = ticks.filter(Number.isFinite);
  const found = magnitudes(finite);
  if (!found.any) {
    return { kind: "integer" };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  let step = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; ++i) {
    if (sorted[i] > sorted[i - 1]) {
      // Rounded, so float noise (3e-4 - 2e-4) does not ask for an extra digit.
      step = Math.min(step, Number((sorted[i] - sorted[i - 1]).toPrecision(12)));
    }
  }
  const decimals = Number.isFinite(step) ? d3.precisionFixed(step) : SIGNIFICANT_DIGITS;
  if (scientific || decimals > MAX_DECIMALS) {
    const digits = Number.isFinite(step) ? d3.precisionRound(step, found.largest) : 1;
    return { kind: "scientific", digits: Math.max(1, Math.min(SIGNIFICANT_DIGITS + 1, digits)) };
  }
  if (found.allIntegers) {
    return { kind: "integer" };
  }
  return { kind: "fixed", decimals };
}

/** A formatter writing every value in `notation`; non-finite values as JavaScript writes them. */
export function formatterFor(notation: Notation): (value: number) => string {
  const format =
    notation.kind === "integer"
      ? plainLocale.format("d")
      : notation.kind === "fixed"
        ? plainLocale.format(`.${notation.decimals}f`)
        : plainLocale.format(`.${notation.digits - 1}e`);
  return (value) => {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    if (notation.kind === "scientific") {
      return value === 0 ? "0" : format(value).replace("e+", "e");
    }
    return format(notation.kind === "integer" ? Math.round(value) : value);
  };
}

/** The decimal exponent `value` is written with at `digits` significant digits. */
function exponentAt(value: number, digits: number): number {
  return Number(value.toExponential(digits - 1).split("e")[1]);
}

/**
 * A formatter writing every value of a column at one width, for a table
 * whose numbers are right-aligned in tabular figures: the column's notation
 * (see `columnNotation`), and in scientific notation, exponents zero-padded
 * to the same number of digits and signed on every value when the column's
 * exponents have both signs. The decimal points then line up, and so do the
 * exponents. Zero is written in the column's notation too.
 */
export function fixedWidthFormatter(values: Iterable<number>): (value: number) => string {
  const found = magnitudes(values);
  const notation = notationOf(found);
  if (notation.kind !== "scientific") {
    return formatterFor(notation);
  }
  const exponents = [
    exponentAt(found.largest, notation.digits),
    ...(Number.isFinite(found.smallest) ? [exponentAt(found.smallest, notation.digits)] : []),
    ...(found.anyZero ? [0] : []),
  ];
  const signed = Math.min(...exponents) < 0 && Math.max(...exponents) >= 0;
  const width = Math.max(...exponents.map((exponent) => String(Math.abs(exponent)).length));
  const format = plainLocale.format(`.${notation.digits - 1}e`);
  return (value) => {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    const [mantissa, exponentText] = format(value).split("e");
    const exponent = Number(exponentText);
    const sign = exponent < 0 ? "-" : signed ? "+" : "";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(width, "0")}`;
  };
}

const SUPERSCRIPTS: { [character: string]: string } = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

const superscript = (exponent: number): string =>
  Array.from(String(exponent), (character) => SUPERSCRIPTS[character]).join("");

/** Whether every one of these powers of ten can be written out (0.01 to 1000). */
export function powersWrittenOut(powers: ReadonlyArray<number>): boolean {
  return powers.every((power) => {
    const exponent = Math.round(Math.log10(power));
    return exponent >= -2 && exponent <= 3;
  });
}

/**
 * Labels of the powers of ten on one log axis: all written out when
 * `writtenOut` (by default, when every one of them can be), otherwise all
 * as 10 with a superscript exponent.
 */
export function powerOfTenLabels(
  powers: ReadonlyArray<number>,
  writtenOut: boolean = powersWrittenOut(powers),
): string[] {
  const exponents = powers.map((power) => Math.round(Math.log10(power)));
  if (writtenOut) {
    return exponents.map((exponent) => d3.format("~r")(10 ** exponent));
  }
  return exponents.map((exponent) => `10${superscript(exponent)}`);
}

/**
 * Writes values as a mantissa of `digits` significant digits times a power
 * of ten with a superscript exponent (1.8×10⁻²): the notation of log axes
 * whose ticks read 10ⁿ.
 */
export function powerOfTenFormatter(digits: number): (value: number) => string {
  const format = plainLocale.format(`.${digits - 1}e`);
  return (value) => {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    if (value === 0) {
      return "0";
    }
    const [mantissa, exponent] = format(value).split("e");
    return `${mantissa}×10${superscript(Number(exponent))}`;
  };
}
