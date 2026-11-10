import { describe, expect, test } from "bun:test";
import type { FilterRange } from "../filters";
import { ParamType } from "../types";
import {
  buildSelectionIndex,
  type IndexInterval,
  selectionIntervals,
  unionIntervals,
  visitIntervalDifference,
} from "./selection_index";

const numeric = (min: number, max: number, include_infnans = false): FilterRange => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
  include_infnans,
});

const index = buildSelectionIndex({
  kind: "numeric",
  values: new Float64Array([9, 1, NaN, Infinity, -Infinity, 1, 0, 1 + Number.EPSILON]),
  missing: new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]),
});
const selected = (ranges: FilterRange[]) =>
  selectionIntervals(index, ranges).flatMap(([start, end]) =>
    Array.from(index.order.slice(start, end)),
  );

describe("sorted selection index", () => {
  test("numeric sorting preserves source precision, original row identity and stable ties", () => {
    expect(Array.from(index.order)).toEqual([4, 1, 5, 7, 0, 3, 2]);
    expect(Array.from(index.missing)).toEqual([6]);
    expect(selected([numeric(1, 1)])).toEqual([1, 5]);
    expect(selected([numeric(1 + Number.EPSILON, 1 + Number.EPSILON)])).toEqual([7]);
  });

  test("infinities obey inclusive bounds even without the special band", () => {
    expect(selected([numeric(-Infinity, Infinity)])).toEqual([4, 1, 5, 7, 0, 3]);
    expect(selected([numeric(Infinity, Infinity)])).toEqual([3]);
    expect(selected([numeric(10, -10, true)])).toEqual([4, 3, 2]);
    expect(selected([numeric(NaN, 10)])).toEqual([]);
    expect(selected([numeric(NaN, NaN, true)])).toEqual([4, 3, 2]);
  });

  test("category ordering is lexical, ties are stable, and explicit categories are exact", () => {
    const categoryIndex = buildSelectionIndex({
      kind: "categorical",
      codes: new Int32Array([0, 1, -1, 2, 1, 3]),
      categories: ["b", "10", "2", "(empty)"],
    });
    expect(Array.from(categoryIndex.order)).toEqual([5, 1, 4, 3, 0]);
    const range: FilterRange = { col: "c", type: ParamType.CATEGORICAL, min: "10", max: "2" };
    expect(selectionIntervals(categoryIndex, [range])).toEqual([[1, 4]]);
    expect(
      selectionIntervals(categoryIndex, [{ ...range, values: ["b", "10", "b", "absent"] }]),
    ).toEqual([
      [1, 3],
      [4, 5],
    ]);
    expect(selectionIntervals(categoryIndex, [{ ...range, values: [] }])).toEqual([]);
    expect(selectionIntervals(categoryIndex, [{ ...range, min: "z", max: "a" }])).toEqual([]);
  });

  test("empty and all-missing columns produce empty unions", () => {
    for (const column of [
      { kind: "numeric" as const, values: new Float64Array(), missing: new Uint8Array() },
      { kind: "numeric" as const, values: new Float64Array(3), missing: new Uint8Array(3).fill(1) },
    ]) {
      expect(
        selectionIntervals(buildSelectionIndex(column), [numeric(-Infinity, Infinity, true)]),
      ).toEqual([]);
    }
  });

  test("overlap and adjacency collapse before symmetric-difference membership changes", () => {
    expect(
      unionIntervals([
        [4, 7],
        [1, 5],
        [7, 9],
        [2, 2],
      ]),
    ).toEqual([[1, 9]]);
    const changes: [number, boolean][] = [];
    visitIntervalDifference([[1, 9]], [[2, 8]], (row, included) => changes.push([row, included]));
    expect(changes).toEqual([
      [1, false],
      [8, false],
    ]);
    const large: number[] = [];
    visitIntervalDifference([[0, 1_000_000]], [[0, 999_999]], (row) => large.push(row));
    expect(large).toEqual([999_999]);
  });

  test("range union differences match exhaustive membership across arbitrary overlap", () => {
    let seed = 781;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const intervals = (): IndexInterval[] =>
      unionIntervals(
        Array.from({ length: 5 }, () => {
          const a = Math.floor(random() * 30);
          const b = Math.floor(random() * 30);
          return [Math.min(a, b), Math.max(a, b)] as const;
        }),
      );
    for (let trial = 0; trial < 100; ++trial) {
      const before = intervals();
      const after = intervals();
      const changes = new Map<number, boolean>();
      visitIntervalDifference(before, after, (row, included) => changes.set(row, included));
      for (let row = 0; row < 30; ++row) {
        const a = before.some(([start, end]) => start <= row && row < end);
        const b = after.some(([start, end]) => start <= row && row < end);
        expect(changes.get(row)).toBe(a === b ? undefined : b);
      }
    }
  });
});
