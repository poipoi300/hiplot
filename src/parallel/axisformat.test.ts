import { describe, expect, test } from "bun:test";
import { create_d3_scale, infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import {
  axisLineOffset,
  axisStyle,
  columnAxis,
  columnAxisStyle,
  formatTimestamp,
  OUTLIER_TICK_LABEL,
  tickCountFor,
  valueFormatter,
} from "./axisformat";
import { densityReference, segmentSamples } from "./webgl";

function columnOf(values: DatapointValue[]) {
  const rows: Datapoint[] = values.map((value, i) => ({ uid: `${i}`, from_uid: null, x: value }));
  return infertypes(new PersistentStateInMemory("", {}), rows).x;
}

function scaleOf(values: DatapointValue[], type?: ParamType) {
  const pd = columnOf(values);
  return create_d3_scale(type === undefined ? pd : { ...pd, type }).range([400, 0]);
}

/** An axis's value formatter in the style its own scale suits. */
function formatterOf(scale: ReturnType<typeof scaleOf>, tickCount: number) {
  return valueFormatter(scale, tickCount, axisStyle(scale, tickCount));
}

/** Tick labels of a column axis. */
function tickLabels(scale: ReturnType<typeof scaleOf>, style = axisStyle(scale, 4)): string[] {
  const axis = columnAxis(scale, 400, style);
  const format = axis.tickFormat();
  return (axis.tickValues() ?? []).map((value) => format?.(value, 0) ?? "");
}

const range = (n: number, map: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => map(i));

describe("tick formats", () => {
  test("a log axis writes all its powers of ten the same way", () => {
    const labels = tickLabels(scaleOf(range(40, (i) => 10 ** (i / 5 - 4))));
    expect(labels).toContain("10⁻²");
    expect(labels.every((label) => label.startsWith("10"))).toBe(true);
  });

  test("brush ends on a log axis read in the notation of its ticks", () => {
    const lr = scaleOf(range(40, (i) => 10 ** (i / 10 - 5)));
    expect(tickLabels(lr)).toContain("10⁻²");
    expect(formatterOf(lr, 4)(0.018)).toBe("1.8×10⁻²");
    const narrow = scaleOf(
      range(40, (i) => 10 ** (i / 20 - 1)),
      ParamType.NUMERICLOG,
    );
    expect(tickLabels(narrow)).toContain("1");
    expect(formatterOf(narrow, 4)(0.18)).toBe("0.180");
  });

  test("an axis rescaled to the rows Keep left writes numbers as the whole column does", () => {
    const all = columnOf(range(40, (i) => 10 ** (i / 5 - 5)));
    const kept = scaleOf(
      range(40, (i) => 10 ** (i / 20 - 1)),
      ParamType.NUMERICLOG,
    );
    const style = columnAxisStyle(all, ParamType.NUMERICLOG, 4);
    expect(style).toEqual({ scientific: true });
    expect(columnAxisStyle(all, ParamType.NUMERICLOG, 4)).toBe(style);
    expect(tickLabels(kept, style)).toContain("10⁰");
    expect(valueFormatter(kept, 4, style)(0.18)).toBe("1.8×10⁻¹");
    const linear = columnOf(range(30, (i) => i * 100_000));
    const zoomed = scaleOf(range(30, (i) => i / 10));
    const linearStyle = columnAxisStyle(linear, ParamType.NUMERIC, 5);
    expect(valueFormatter(zoomed, 5, linearStyle)(1.5)).toBe("1.5e0");
  });

  test("a linear axis writes every tick in one notation", () => {
    const large = formatterOf(scaleOf(range(30, (i) => i * 100_000)), 5);
    expect([0, 1_000_000, 2_500_000].map(large)).toEqual(["0", "1.0e6", "2.5e6"]);
    const small = formatterOf(scaleOf(range(30, (i) => i / 10)), 5);
    expect([0.5, 1.5, 2].map(small)).toEqual(["0.5", "1.5", "2.0"]);
  });

  test("percentile axes use three significant digits, the outlier band its own label", () => {
    const format = formatterOf(
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
    const categories = scaleOf(range(60, (i) => i).map((i) => `c${i}`));
    const axis = columnAxis(categories, 300, axisStyle(categories, 3));
    const shown = axis.tickValues();
    expect(shown?.length).toBeLessThan(60);
    expect(shown?.[0]).toBe("c0");
  });

  test("log axes tick on powers of ten and keep the outlier band", () => {
    const scale = scaleOf([...range(40, (i) => 10 ** (i / 5 - 4)), "inf"]);
    const axis = columnAxis(scale, 400, axisStyle(scale, 4));
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

describe("axis line", () => {
  test("the axis line sits half a pixel in at a pixel ratio of 1 and on the origin above", () => {
    expect(axisLineOffset(1)).toBe(0.5);
    expect(axisLineOffset(1.5)).toBe(0);
    expect(axisLineOffset(2)).toBe(0);
  });

  test("a column's axis draws its line at that offset", () => {
    const scale = create_d3_scale(columnOf([1, 2, 3])).range([100, 0]);
    const axis = columnAxis(scale, 100, columnAxisStyle(columnOf([1, 2, 3]), ParamType.NUMERIC, 5));
    expect(axis.offset()).toBe(axisLineOffset(window.devicePixelRatio));
  });
});
