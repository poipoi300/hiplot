import { describe, expect, test } from "bun:test";
import { create_d3_scale, infertypes } from "../infertypes";
import { colorBinning } from "../lib/colors";
import { PersistentStateInMemory } from "../lib/savedstate";
import type { Datapoint } from "../types";
import { LineGeometry, shuffledIndices } from "./geometry";

const rows: Datapoint[] = [
  { uid: "0", from_uid: null, x: 0, c: "a" },
  { uid: "1", from_uid: null, x: 5, c: "b" },
  { uid: "2", from_uid: null, x: 10, c: "a" },
  { uid: "3", from_uid: null, x: "inf", c: "b" },
  { uid: "4", from_uid: null, c: "a" },
];
const params = infertypes(new PersistentStateInMemory("", {}), rows);

describe("draw order", () => {
  test("is a permutation of every row", () => {
    const order = shuffledIndices(100);
    expect(Array.from(order).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
  });

  test("is fixed for the lifetime of the geometry", () => {
    const geometry = new LineGeometry(rows);
    expect(geometry.order).toBe(geometry.order);
    expect(geometry.order).toHaveLength(rows.length);
  });
});

describe("cached pixels", () => {
  test("rows map through the scale and missing values become NaN", () => {
    const geometry = new LineGeometry(rows);
    const scale = create_d3_scale(params.x).range([100, 0]);
    const pixels = geometry.pixels("x", scale, true);
    expect(pixels[0]).toBe(100);
    expect(Number.isNaN(pixels[3])).toBe(true);
    expect(Number.isNaN(pixels[4])).toBe(true);
  });

  test("are reused until the scale or its range changes", () => {
    const geometry = new LineGeometry(rows);
    const scale = create_d3_scale(params.x).range([100, 0]);
    const first = geometry.pixels("x", scale, true);
    expect(geometry.pixels("x", scale, true)).toBe(first);
    scale.range([0, 100]);
    const inverted = geometry.pixels("x", scale, true);
    expect(inverted).not.toBe(first);
    expect(inverted[0]).toBe(0);
    expect(geometry.pixels("x", create_d3_scale(params.x).range([0, 100]), true)).not.toBe(
      inverted,
    );
  });
});

describe("cached colors", () => {
  test("bins follow the binning and are rebuilt for another color-by column", () => {
    const geometry = new LineGeometry(rows);
    const binning = colorBinning(params.c, null);
    const bins = geometry.colorBins(binning, "c");
    expect(Array.from(bins)).toEqual([0, 1, 0, 1, 0]);
    expect(geometry.colorBins(binning, "c")).toBe(bins);
    expect(geometry.colorBins(colorBinning(params.x, null), "x")).not.toBe(bins);
  });

  test("the lowest or highest values are drawn last, missing values first", () => {
    const geometry = new LineGeometry(rows);
    // Bins of a three-bin color map, then the missing bin 3.
    const bins = Uint32Array.from([2, 0, 1, 3, 0]);
    const valuesInOrder = (mode: "lowest" | "highest") =>
      Array.from(geometry.colorOrder(bins, 3, mode), (row) => bins[row]);
    expect(valuesInOrder("highest")).toEqual([3, 0, 0, 1, 2]);
    expect(valuesInOrder("lowest")).toEqual([3, 2, 1, 0, 0]);
    expect(geometry.colorOrder(bins, 3, "highest")).toBe(geometry.colorOrder(bins, 3, "highest"));
  });

  test("rows of one color keep their shuffled order", () => {
    const geometry = new LineGeometry(rows);
    const bins = new Uint32Array(rows.length);
    expect(Array.from(geometry.colorOrder(bins, 3, "highest"))).toEqual(Array.from(geometry.order));
  });

  test("the mean mode and categorical columns keep the shuffled order", () => {
    const geometry = new LineGeometry(rows);
    const bins = Uint32Array.from([2, 0, 1, 3, 0]);
    expect(geometry.colorOrder(bins, 3, "mean")).toBe(geometry.order);
    expect(geometry.colorOrder(bins, 0, "highest")).toBe(geometry.order);
  });

  test("row lookups keep original positions and the last occurrence of duplicate identities", () => {
    const geometry = new LineGeometry(rows);
    expect(rows.map((row) => geometry.indexOf(row))).toEqual([0, 1, 2, 3, 4]);
    expect(new LineGeometry([rows[0], rows[1], rows[0]]).indexOf(rows[0])).toBe(2);
  });

  test("rows of another dataset are rejected", () => {
    expect(() => new LineGeometry(rows).indexOf({ uid: "z", from_uid: null })).toThrow(
      "not part of the plotted rows",
    );
  });
});
