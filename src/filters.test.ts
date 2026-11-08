import { describe, expect, test } from "bun:test";
import {
  anyOfRanges,
  apply_filter,
  apply_filters,
  columnConditionHolds,
  type Filter,
  FilterType,
  isFilter,
  parseColumnCondition,
} from "./filters";
import { type Datapoint, ParamType } from "./types";

const table: Datapoint[] = [
  { uid: "a", from_uid: null, loss: 0.1, opt: "adam" },
  { uid: "b", from_uid: null, loss: 0.5, opt: "sgd" },
  { uid: "c", from_uid: null, loss: "inf", opt: "adam" },
  { uid: "d", from_uid: null, opt: "rmsprop" },
];
const uids = (selected: Datapoint[]) => selected.map((row) => row.uid);

const lossRange = (min: number, max: number, include_infnans = false): Filter => ({
  type: FilterType.Range,
  data: { col: "loss", type: ParamType.NUMERIC, min, max, include_infnans },
});

describe("filters", () => {
  test("a numeric range keeps rows inside it and drops missing values", () => {
    expect(uids(apply_filter(table, lossRange(0, 0.3)))).toEqual(["a"]);
  });

  test("a numeric range can also keep inf and nan values", () => {
    expect(uids(apply_filter(table, lossRange(0.4, 1, true)))).toEqual(["b", "c"]);
  });

  test("a categorical range compares category strings", () => {
    const filter: Filter = {
      type: FilterType.Range,
      data: { col: "opt", type: ParamType.CATEGORICAL, min: "adam", max: "rmsprop" },
    };
    expect(uids(apply_filter(table, filter))).toEqual(["a", "c", "d"]);
  });

  test("search matches any cell, case-insensitively and literally", () => {
    expect(uids(apply_filter(table, { type: FilterType.Search, data: "SGD" }))).toEqual(["b"]);
    expect(uids(apply_filter(table, { type: FilterType.Search, data: "0." }))).toEqual(["a", "b"]);
    expect(apply_filter(table, { type: FilterType.Search, data: "a.a" })).toEqual([]);
  });

  test("All, Not and None combine predicates", () => {
    const notAdam: Filter = {
      type: FilterType.Not,
      data: { type: FilterType.Search, data: "adam" },
    };
    const both: Filter = { type: FilterType.All, data: [lossRange(0, 1), notAdam] };
    expect(uids(apply_filter(table, both))).toEqual(["b"]);
    expect(apply_filter(table, { type: FilterType.None, data: {} })).toEqual([]);
  });

  test("filters apply in sequence and leave the input untouched", () => {
    const input = table.slice();
    const kept = apply_filters(input, [lossRange(0, 1), { type: FilterType.Search, data: "sgd" }]);
    expect(uids(kept)).toEqual(["b"]);
    expect(input).toEqual(table);
  });
});

describe("filter validation", () => {
  test("well-formed filters, including nested ones, are accepted", () => {
    expect(isFilter(lossRange(0, 1))).toBe(true);
    expect(isFilter({ type: FilterType.Not, data: { type: FilterType.All, data: [] } })).toBe(true);
  });

  test("malformed filters from storage are rejected", () => {
    for (const value of [
      null,
      [],
      { type: "Nope", data: {} },
      { type: FilterType.Range, data: { col: "x", type: "numeric", min: "0", max: 1 } },
      { type: FilterType.Search, data: 3 },
      { type: FilterType.All, data: [{ type: FilterType.None }] },
    ]) {
      expect(isFilter(value)).toBe(false);
    }
  });
});

describe("column filter conditions", () => {
  test("comparisons and ranges read as numbers, anything else as text", () => {
    expect(parseColumnCondition(" >= 1e-3 ")).toEqual({
      kind: "compare",
      operator: ">=",
      value: 0.001,
    });
    expect(parseColumnCondition("0.5..-0.5")).toEqual({ kind: "range", min: -0.5, max: 0.5 });
    expect(parseColumnCondition("AdamW")).toEqual({ kind: "text", text: "adamw" });
    expect(parseColumnCondition(">fast")).toEqual({ kind: "text", text: ">fast" });
    expect(parseColumnCondition("   ")).toBeNull();
  });

  test("only finite numbers meet numeric conditions", () => {
    const below = { kind: "compare", operator: "<", value: 1 } as const;
    expect(columnConditionHolds(below, 0.5)).toBe(true);
    expect(columnConditionHolds(below, "0.5")).toBe(true);
    expect(columnConditionHolds(below, "inf")).toBe(false);
    expect(columnConditionHolds(below, undefined)).toBe(false);
    for (const [operator, expected] of [
      ["<=", true],
      [">", false],
      [">=", true],
      ["=", true],
    ] as const) {
      expect(columnConditionHolds({ kind: "compare", operator, value: 1 }, 1)).toBe(expected);
    }
    expect(columnConditionHolds({ kind: "range", min: 0, max: 1 }, 1)).toBe(true);
    expect(columnConditionHolds({ kind: "text", text: "dam" }, "AdamW")).toBe(true);
  });

  test("a column filter selects the rows its condition holds for, and persists", () => {
    const rows: Datapoint[] = [
      { uid: "a", from_uid: null, lr: 0.1 },
      { uid: "b", from_uid: null, lr: 0.01 },
    ];
    const filter: Filter = { type: FilterType.Column, data: { col: "lr", query: "<0.05" } };
    expect(apply_filter(rows, filter).map((row) => row.uid)).toEqual(["b"]);
    expect(apply_filter(rows, { ...filter, data: { col: "lr", query: "" } })).toHaveLength(2);
    expect(isFilter(JSON.parse(JSON.stringify(filter)))).toBe(true);
    expect(isFilter({ type: FilterType.Column, data: { col: "lr" } })).toBe(false);
  });
});

describe("multi-range brush filters", () => {
  const optValues = (values: string[]): Filter => ({
    type: FilterType.Range,
    data: {
      col: "opt",
      type: ParamType.CATEGORICAL,
      min: values[0],
      max: values[values.length - 1],
      values,
    },
  });

  test("an Any filter keeps rows meeting at least one of its filters", () => {
    const either: Filter = { type: FilterType.Any, data: [lossRange(0, 0.2), lossRange(0.4, 1)] };
    expect(uids(apply_filter(table, either))).toEqual(["a", "b"]);
    expect(apply_filter(table, { type: FilterType.Any, data: [] })).toEqual([]);
  });

  test("an excluded multi-range selection drops the rows in any of its ranges", () => {
    const either: Filter = { type: FilterType.Any, data: [lossRange(0, 0.2), optValues(["sgd"])] };
    expect(uids(apply_filter(table, { type: FilterType.Not, data: either }))).toEqual(["c", "d"]);
  });

  test("categorical ranges with values select those categories, whatever their string order", () => {
    expect(uids(apply_filter(table, optValues(["adam", "sgd"])))).toEqual(["a", "b", "c"]);
  });

  test("the brushes of an axis become none, one range, or an Any of ranges", () => {
    const range = { col: "loss", type: ParamType.NUMERIC, min: 0, max: 1 } as const;
    expect(anyOfRanges([])).toEqual({ type: FilterType.None, data: {} });
    expect(anyOfRanges([range])).toEqual({ type: FilterType.Range, data: range });
    expect(anyOfRanges([range, range])).toEqual({
      type: FilterType.Any,
      data: [
        { type: FilterType.Range, data: range },
        { type: FilterType.Range, data: range },
      ],
    });
  });

  test("multi-range filters survive a round trip through saved state", () => {
    const saved: Filter[] = [
      {
        type: FilterType.All,
        data: [
          { type: FilterType.Any, data: [lossRange(0, 0.2), lossRange(0.4, 1)] },
          optValues(["adam", "sgd"]),
        ],
      },
    ];
    const restored: unknown = JSON.parse(JSON.stringify(saved));
    expect(Array.isArray(restored) && restored.every(isFilter)).toBe(true);
    expect(uids(apply_filters(table, restored as Filter[]))).toEqual(["a", "b"]);
  });

  test("filters saved before multi-range brushes still load and replay", () => {
    // As earlier versions saved Keep and Exclude: one range per axis, categories by bounds.
    const saved: unknown = JSON.parse(
      JSON.stringify([
        {
          type: "All",
          data: [
            { type: "Range", data: { col: "loss", type: "numeric", min: 0, max: 1 } },
            { type: "Range", data: { col: "opt", type: "categorical", min: "adam", max: "sgd" } },
          ],
        },
        { type: "Not", data: { type: "None", data: {} } },
      ]),
    );
    expect(Array.isArray(saved) && saved.every(isFilter)).toBe(true);
    expect(uids(apply_filters(table, saved as Filter[]))).toEqual(["a", "b"]);
  });

  test("malformed multi-range filters are rejected", () => {
    expect(isFilter({ type: FilterType.Any, data: {} })).toBe(false);
    expect(isFilter({ type: FilterType.Any, data: [{ type: FilterType.Search, data: 1 }] })).toBe(
      false,
    );
    expect(
      isFilter({
        type: FilterType.Range,
        data: { col: "opt", type: "categorical", min: "a", max: "b", values: [1] },
      }),
    ).toBe(false);
  });
});
