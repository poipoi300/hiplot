import { describe, expect, test } from "bun:test";
import { apply_filter, apply_filters, type Filter, FilterType, isFilter } from "./filters";
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
