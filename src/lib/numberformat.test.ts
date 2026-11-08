import { describe, expect, test } from "bun:test";
import {
  columnNotation,
  fixedWidthFormatter,
  formatterFor,
  powerOfTenLabels,
  tickNotation,
} from "./numberformat";

const formatColumn = (values: number[]): string[] =>
  values.map(formatterFor(columnNotation(values)));
const formatTicks = (ticks: number[]): string[] => ticks.map(formatterFor(tickNotation(ticks)));

describe("one notation per table column", () => {
  test("integer columns stay whole", () => {
    expect(columnNotation([32, 64, 128, 512])).toEqual({ kind: "integer" });
    expect(formatColumn([26122, 9610])).toEqual(["26122", "9610"]);
  });

  test("a column with values below 1e-3 is all scientific", () => {
    const weightDecay = [3.49902e-5, 0.00242109, 1.92023e-5, 0.000873024];
    expect(columnNotation(weightDecay)).toEqual({ kind: "scientific", digits: 3 });
    expect(formatColumn(weightDecay)).toEqual(["3.50e-5", "2.42e-3", "1.92e-5", "8.73e-4"]);
  });

  test("a column of moderate magnitudes is all fixed with the same decimals", () => {
    const dropout = [0.0455686, 0.2345, 0.0888578, 0.6];
    expect(columnNotation(dropout)).toEqual({ kind: "fixed", decimals: 4 });
    expect(formatColumn(dropout)).toEqual(["0.0456", "0.2345", "0.0889", "0.6000"]);
  });

  test("huge or tiny magnitudes are scientific", () => {
    expect(columnNotation([1.5e7, 2.5e6])).toEqual({ kind: "scientific", digits: 3 });
    expect(columnNotation([2e-4, 5e-4])).toEqual({ kind: "scientific", digits: 3 });
    expect(columnNotation([2e6, 3e6])).toEqual({ kind: "scientific", digits: 3 });
    expect(formatColumn([1.5e7])).toEqual(["1.50e7"]);
  });

  test("zeros and non-finite values do not decide, and are still written", () => {
    expect(columnNotation([0, 0.5, Number.NaN, 1.25])).toEqual({ kind: "fixed", decimals: 3 });
    expect(columnNotation([])).toEqual({ kind: "integer" });
    expect(formatterFor({ kind: "fixed", decimals: 2 })(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  test("negative values are written with a plain minus, so they paste as numbers", () => {
    expect(formatColumn([-2.5, 3.75])).toEqual(["-2.50", "3.75"]);
  });
});

describe("one width per table column", () => {
  const formatTable = (values: number[]): string[] => values.map(fixedWidthFormatter(values));
  const widths = (texts: string[]): Set<number> => new Set(texts.map((text) => text.length));

  test("scientific exponents are zero-padded and signed alike when they have both signs", () => {
    const texts = formatTable([3.5e-5, 2.42e-3, 1.5e12, 0, 7]);
    expect(texts).toEqual(["3.50e-05", "2.42e-03", "1.50e+12", "0.00e+00", "7.00e+00"]);
    expect(widths(texts).size).toBe(1);
  });

  test("exponents of one sign carry no plus sign, still at one width", () => {
    expect(formatTable([3.5e-5, 2.42e-12])).toEqual(["3.50e-05", "2.42e-12"]);
    expect(formatTable([1.5e7, 2.5e6])).toEqual(["1.50e7", "2.50e6"]);
  });

  test("rounding that carries into the next power of ten is counted in the exponent width", () => {
    expect(formatTable([9.996e9, 2e-4])).toEqual(["1.00e+10", "2.00e-04"]);
  });

  test("fixed columns share their decimals, so right-aligned decimal points line up", () => {
    expect(formatTable([0.0455686, 12.5, 0.6])).toEqual(["0.0456", "12.5000", "0.6000"]);
  });

  test("a value's text depends on the whole column, not on which rows are shown", () => {
    const column = [3.5e-5, 0.25, 0.75];
    const format = fixedWidthFormatter(column);
    expect([0.25, 0.75].map(format)).toEqual(["2.50e-1", "7.50e-1"]);
    expect([0.25, 0.75].map(fixedWidthFormatter([0.25, 0.75]))).toEqual(["0.250", "0.750"]);
  });

  test("non-finite values are written as they are", () => {
    expect(fixedWidthFormatter([1e-5, 1])(Number.NaN)).toBe("NaN");
  });
});

describe("one notation per axis", () => {
  test("ticks share the decimals their step needs", () => {
    expect(formatTicks([0, 0.2, 0.4, 0.6, 0.8, 1])).toEqual([
      "0.0",
      "0.2",
      "0.4",
      "0.6",
      "0.8",
      "1.0",
    ]);
    expect(formatTicks([0, 0.05, 0.1, 0.15])).toEqual(["0.00", "0.05", "0.10", "0.15"]);
    expect(formatTicks([0, 5000, 10000, 15000])).toEqual(["0", "5000", "10000", "15000"]);
  });

  test("an axis of huge values is all scientific, with digits that keep ticks apart", () => {
    expect(formatTicks([0, 2e6, 4e6, 6e6])).toEqual(["0", "2e6", "4e6", "6e6"]);
    expect(formatTicks([1.2e6, 1.4e6, 1.6e6])).toEqual(["1.2e6", "1.4e6", "1.6e6"]);
  });

  test("an axis of tiny values is all scientific", () => {
    expect(formatTicks([1e-4, 2e-4, 3e-4])).toEqual(["1e-4", "2e-4", "3e-4"]);
  });
});

describe("powers of ten on log axes", () => {
  test("written out when every power is between 0.01 and 1000", () => {
    expect(powerOfTenLabels([0.01, 0.1, 1, 10, 100])).toEqual(["0.01", "0.1", "1", "10", "100"]);
  });

  test("all as superscript exponents when one of them cannot be written out", () => {
    expect(powerOfTenLabels([1e-4, 1e-3, 0.01, 0.1, 1])).toEqual([
      "10⁻⁴",
      "10⁻³",
      "10⁻²",
      "10⁻¹",
      "10⁰",
    ]);
    expect(powerOfTenLabels([1, 1e5])).toEqual(["10⁰", "10⁵"]);
  });
});
