import { describe, expect, test } from "bun:test";
import { create_d3_scale, infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import {
  columnAxis,
  formatTimestamp,
  OUTLIER_TICK_LABEL,
  tickCountFor,
  valueFormatter,
} from "./axisformat";
import { densityReference, segmentSamples } from "./webgl";

function scaleOf(values: DatapointValue[], type?: ParamType) {
  const rows: Datapoint[] = values.map((value, i) => ({ uid: `${i}`, from_uid: null, x: value }));
  const pd = infertypes(new PersistentStateInMemory("", {}), rows).x;
  return create_d3_scale(type === undefined ? pd : { ...pd, type }).range([400, 0]);
}

const range = (n: number, map: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => map(i));

describe("tick formats", () => {
  test("a log axis writes all its powers of ten the same way", () => {
    const wide = columnAxis(scaleOf(range(40, (i) => 10 ** (i / 5 - 4))), 400);
    const format = wide.tickFormat();
    const labels = (wide.tickValues() ?? []).map((value) => format?.(value, 0));
    expect(labels).toContain("10⁻²");
    expect(labels.every((label) => label?.startsWith("10"))).toBe(true);
  });

  test("a linear axis writes every tick in one notation", () => {
    const large = valueFormatter(scaleOf(range(30, (i) => i * 100_000)), 5);
    expect([0, 1_000_000, 2_500_000].map(large)).toEqual(["0", "1.0e6", "2.5e6"]);
    const small = valueFormatter(scaleOf(range(30, (i) => i / 10)), 5);
    expect([0.5, 1.5, 2].map(small)).toEqual(["0.5", "1.5", "2.0"]);
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

describe("line density", () => {
  test("the density reference grows with lines per pixel of height", () => {
    expect(densityReference(10, 400)).toBe(2);
    expect(densityReference(50_000, 500)).toBe(1200);
  });
});

describe("curve sampling", () => {
  test("straight segments need their two ends only", () => {
    expect(segmentSamples([{ x: 0 }, { x: 600 }], false)).toBe(2);
  });

  test("curves get a point every few pixels of the widest gap, within bounds", () => {
    expect(segmentSamples([{ x: 0 }, { x: 10 }], true)).toBe(8);
    expect(segmentSamples([{ x: 0 }, { x: 60 }, { x: 180 }], true)).toBe(21);
    expect(segmentSamples([{ x: 0 }, { x: 2000 }], true)).toBe(40);
  });
});
