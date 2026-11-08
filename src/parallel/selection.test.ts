import { describe, expect, test } from "bun:test";
import { anyOfRanges, apply_filters, type FilterRange } from "../filters";
import { type Datapoint, ParamType } from "../types";
import { type AxisSelection, BrushMasks } from "./selection";

const rows: Datapoint[] = [
  { uid: "0", from_uid: null, x: 1, c: "a" },
  { uid: "1", from_uid: null, x: "5", c: "b" },
  { uid: "2", from_uid: null, x: "inf", c: "" },
  { uid: "3", from_uid: null, x: Number.NaN, c: "c" },
  { uid: "4", from_uid: null, c: "b" },
  { uid: "5", from_uid: null, x: 9, c: 10 },
];
const uids = (selected: Datapoint[]) => selected.map((row) => row.uid);

function select(masks: BrushMasks, selections: [string, AxisSelection][]): string[] {
  return uids(masks.selectedRows(masks.select(new Map(selections))));
}

const xRange = (min: number, max: number, include_infnans = false): FilterRange => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
  include_infnans,
});
const cRange = (min: string, max: string): FilterRange => ({
  col: "c",
  type: ParamType.CATEGORICAL,
  min,
  max,
});
const cValues = (values: string[]): FilterRange => ({
  col: "c",
  type: ParamType.CATEGORICAL,
  min: values[0],
  max: values[values.length - 1],
  values,
});

describe("brush masks", () => {
  test("numeric ranges parse values and never select missing ones", () => {
    expect(select(new BrushMasks(rows), [["x", [xRange(0, 6)]]])).toEqual(["0", "1"]);
  });

  test("numeric ranges can include inf and nan values", () => {
    expect(select(new BrushMasks(rows), [["x", [xRange(4, 6, true)]]])).toEqual(["1", "2", "3"]);
  });

  test("categorical ranges without values compare category strings, with (empty) for empty strings", () => {
    expect(select(new BrushMasks(rows), [["c", [cRange("(empty)", "b")]]])).toEqual([
      "0",
      "1",
      "2",
      "4",
      "5",
    ]);
  });

  test("categorical ranges with values select exactly those categories", () => {
    // "10" sorts before "b" as a string, but is not one of the brushed categories.
    expect(select(new BrushMasks(rows), [["c", [cValues(["a", "b"])]]])).toEqual(["0", "1", "4"]);
  });

  test("an axis whose brushes select no value selects nothing", () => {
    expect(select(new BrushMasks(rows), [["c", []]])).toEqual([]);
  });

  test("the ranges of one axis select the rows in any of them", () => {
    const masks = new BrushMasks(rows);
    expect(select(masks, [["x", [xRange(0, 2), xRange(8, 10)]]])).toEqual(["0", "5"]);
    expect(select(masks, [["c", [cValues(["a"]), cValues(["c", "10"])]]])).toEqual(["0", "3", "5"]);
    // Overlapping ranges count each row once.
    expect(select(masks, [["x", [xRange(0, 6), xRange(4, 10, true)]]])).toEqual([
      "0",
      "1",
      "2",
      "3",
      "5",
    ]);
  });

  test("brushes on several axes intersect, and no brush selects everything", () => {
    const masks = new BrushMasks(rows);
    expect(select(masks, [])).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(
      select(masks, [
        ["x", [xRange(0, 10)]],
        ["c", [cRange("b", "c")]],
      ]),
    ).toEqual(["1"]);
    expect(
      select(masks, [
        ["x", [xRange(0, 2), xRange(8, 10)]],
        ["c", [cValues(["10"]), cValues(["b"])]],
      ]),
    ).toEqual(["5"]);
  });

  test("only the axis whose ranges changed computes its mask again", () => {
    const masks = new BrushMasks(rows);
    const first = masks.axisMask("x", [xRange(0, 6)]);
    const other = masks.axisMask("c", [cValues(["a"])]);
    expect(masks.axisMask("x", [xRange(0, 6)])).toBe(first);
    expect(masks.axisMask("x", [xRange(0, 6), xRange(8, 9)])).not.toBe(first);
    expect(masks.axisMask("c", [cValues(["a"])])).toBe(other);
  });

  test("masks select exactly the rows the equivalent filters keep", () => {
    const selections: [string, AxisSelection][] = [
      ["x", [xRange(0, 2, true), xRange(8, 9)]],
      ["c", [cRange("10", "b"), cValues(["c"])]],
    ];
    const filters = selections.map(([, selection]) => anyOfRanges(selection));
    expect(select(new BrushMasks(rows), selections)).toEqual(uids(apply_filters(rows, filters)));
    expect(select(new BrushMasks(rows), [["c", []]])).toEqual(
      uids(apply_filters(rows, [anyOfRanges([])])),
    );
  });
});
