import { describe, expect, test } from "bun:test";
import type { Datapoint } from "../types";
import { categoryIndices, countByCategory, flowAxes } from "./flow";

const categorical = new Set(["optimizer", "activation"]);
const isCategorical = (dimension: string) => categorical.has(dimension);

describe("which axes show flow badges", () => {
  test("a categorical axis next to a brushed one, with the side the flow comes from", () => {
    const dimensions = ["lr", "optimizer", "dropout", "activation", "loss"];
    expect(flowAxes(dimensions, new Set(["lr"]), isCategorical)).toEqual([
      { dimension: "optimizer", from: "left" },
    ]);
    expect(flowAxes(dimensions, new Set(["loss"]), isCategorical)).toEqual([
      { dimension: "activation", from: "right" },
    ]);
  });

  test("numeric neighbors and axes away from brushes get none", () => {
    const dimensions = ["lr", "dropout", "optimizer"];
    expect(flowAxes(dimensions, new Set(["lr"]), isCategorical)).toEqual([]);
    expect(flowAxes(dimensions, new Set(), isCategorical)).toEqual([]);
  });

  test("between two brushed axes the flow is counted once, from the left", () => {
    const dimensions = ["lr", "optimizer", "loss"];
    expect(flowAxes(dimensions, new Set(["lr", "loss"]), isCategorical)).toEqual([
      { dimension: "optimizer", from: "left" },
    ]);
  });
});

describe("counting selected rows per category", () => {
  const rows: Datapoint[] = [
    { uid: "0", from_uid: null, optimizer: "sgd" },
    { uid: "1", from_uid: null, optimizer: "adam" },
    { uid: "2", from_uid: null, optimizer: "sgd" },
    { uid: "3", from_uid: null },
    { uid: "4", from_uid: null, optimizer: "rmsprop" },
  ];

  test("rows map to their category, missing and unknown values to -1", () => {
    expect(Array.from(categoryIndices(rows, "optimizer", ["adam", "sgd"]))).toEqual([
      1, 0, 1, -1, -1,
    ]);
  });

  test("only selected rows with a category are counted", () => {
    const indices = categoryIndices(rows, "optimizer", ["adam", "sgd"]);
    const selected = Uint8Array.from([1, 0, 1, 1, 1]);
    expect(Array.from(countByCategory(indices, selected, 2))).toEqual([0, 2]);
  });

  test("selection flags must cover the same rows", () => {
    expect(() => countByCategory(new Int32Array(2), new Uint8Array(3), 1)).toThrow();
  });
});
