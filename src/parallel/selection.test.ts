import { describe, expect, test } from "bun:test";
import { apply_filters, type Filter, FilterType } from "../filters";
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

const xRange = (min: number, max: number, include_infnans = false): AxisSelection => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
  include_infnans,
});
const cRange = (min: string, max: string): AxisSelection => ({
  col: "c",
  type: ParamType.CATEGORICAL,
  min,
  max,
});

describe("brush masks", () => {
  test("numeric ranges parse values and never select missing ones", () => {
    expect(select(new BrushMasks(rows), [["x", xRange(0, 6)]])).toEqual(["0", "1"]);
  });

  test("numeric ranges can include inf and nan values", () => {
    expect(select(new BrushMasks(rows), [["x", xRange(4, 6, true)]])).toEqual(["1", "2", "3"]);
  });

  test("categorical ranges compare category strings, with (empty) for empty strings", () => {
    expect(select(new BrushMasks(rows), [["c", cRange("(empty)", "b")]])).toEqual([
      "0",
      "1",
      "2",
      "4",
      "5",
    ]);
  });

  test("an empty categorical brush selects nothing", () => {
    expect(select(new BrushMasks(rows), [["c", "nothing"]])).toEqual([]);
  });

  test("brushes on several axes intersect, and no brush selects everything", () => {
    const masks = new BrushMasks(rows);
    expect(select(masks, [])).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(
      select(masks, [
        ["x", xRange(0, 10)],
        ["c", cRange("b", "c")],
      ]),
    ).toEqual(["1"]);
  });

  test("an unchanged axis reuses its mask", () => {
    const masks = new BrushMasks(rows);
    const first = masks.axisMask("x", xRange(0, 6));
    expect(masks.axisMask("x", xRange(0, 6))).toBe(first);
    expect(masks.axisMask("x", xRange(0, 7))).not.toBe(first);
  });

  test("masks select exactly the rows the equivalent filters keep", () => {
    const selections: [string, AxisSelection][] = [
      ["x", xRange(0, 9, true)],
      ["c", cRange("10", "b")],
    ];
    const filters: Filter[] = selections.map(([, selection]) =>
      selection === "nothing"
        ? { type: FilterType.None, data: {} }
        : { type: FilterType.Range, data: selection },
    );
    expect(select(new BrushMasks(rows), selections)).toEqual(uids(apply_filters(rows, filters)));
  });
});
