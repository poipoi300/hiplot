import { describe, expect, test } from "bun:test";
import { create_d3_scale, infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import {
  columnAxis,
  formatPowerOfTen,
  formatTimestamp,
  OUTLIER_TICK_LABEL,
  tickCountFor,
  valueFormatter,
} from "./axisformat";
import { segmentWeight } from "./parallel";
import { densityReference } from "./webgl";

function scaleOf(values: DatapointValue[], type?: ParamType) {
  const rows: Datapoint[] = values.map((value, i) => ({ uid: `${i}`, from_uid: null, x: value }));
  const pd = infertypes(new PersistentStateInMemory("", {}), rows).x;
  return create_d3_scale(type === undefined ? pd : { ...pd, type }).range([400, 0]);
}

const range = (n: number, map: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => map(i));

describe("tick formats", () => {
  test("powers of ten are written out near 1 and as 1eN beyond", () => {
    expect([1e-3, 0.01, 1, 1000, 1e4].map(formatPowerOfTen)).toEqual([
      "1e-3",
      "0.01",
      "1",
      "1000",
      "1e4",
    ]);
  });

  test("large linear values use SI prefixes, small ones stay plain", () => {
    const large = valueFormatter(scaleOf(range(30, (i) => i * 10_000)), 5);
    expect(large(120_000)).toBe("120k");
    const small = valueFormatter(scaleOf(range(30, (i) => i / 10)), 5);
    expect(small(1.5)).toBe("1.5");
  });

  test("percentile axes use three significant digits, the outlier band its own label", () => {
    const format = valueFormatter(
      scaleOf([...range(30, (i) => 10 ** (i / 5)), "inf"], ParamType.NUMERICPERCENTILE),
      5,
    );
    expect(format(80)).toBe("80");
    expect(format(Number.NaN)).toBe(OUTLIER_TICK_LABEL);
  });

  test("timestamps at brush ends show the full date", () => {
    expect(formatTimestamp(0)).toMatch(/^19(69|70)-/);
  });

  test("fewer ticks on shorter axes, never fewer than two", () => {
    expect(tickCountFor(450)).toBe(5);
    expect(tickCountFor(60)).toBe(2);
  });
});

describe("column axes", () => {
  test("crowded categories are thinned to keep labels apart", () => {
    const axis = columnAxis(scaleOf(range(60, (i) => i).map((i) => `c${i}`)), 300);
    const shown = axis.tickValues();
    expect(shown?.length).toBeLessThan(60);
    expect(shown?.[0]).toBe("c0");
  });

  test("log axes tick on powers of ten and keep the outlier band", () => {
    const axis = columnAxis(scaleOf([...range(40, (i) => 10 ** (i / 5 - 4)), "inf"]), 400);
    const shown = axis.tickValues() ?? [];
    expect(shown).toContain(1);
    expect(Number.isNaN(shown[shown.length - 1] as number)).toBe(true);
  });
});

describe("line geometry", () => {
  test("straight lines move linearly between axes", () => {
    expect(segmentWeight(0.25, false)).toBe(0.25);
    expect(segmentWeight(-1, false)).toBe(0);
  });

  test("curves stay level near each axis and cross halfway at the middle", () => {
    expect(segmentWeight(0, true)).toBeCloseTo(0);
    expect(segmentWeight(0.5, true)).toBeCloseTo(0.5);
    expect(segmentWeight(1, true)).toBeCloseTo(1);
    expect(segmentWeight(0.1, true)).toBeLessThan(0.1);
  });

  test("the density reference grows with lines per pixel of height", () => {
    expect(densityReference(10, 400)).toBe(2);
    expect(densityReference(50_000, 500)).toBe(1200);
  });
});
