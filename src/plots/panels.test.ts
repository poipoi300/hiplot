import { describe, expect, test } from "bun:test";
import {
  distributionAxesToMigrate,
  isDistributionPanels,
  isScatterPanels,
  nextPanelId,
  normalizeScatterPanel,
  plottedColumns,
  scatterKind,
  withOneAxisPanels,
} from "./panels";

test("saved panel lists are validated before use", () => {
  expect(isScatterPanels([{ id: "1", x: "lr", y: null, z: null }])).toBe(true);
  expect(isScatterPanels([{ id: 1, x: "lr", y: null, z: null }])).toBe(false);
  expect(isScatterPanels({ id: "1" })).toBe(false);
  expect(isDistributionPanels([{ id: "2", axis: "loss" }])).toBe(true);
  expect(isDistributionPanels([{ id: "2", axis: 3 }])).toBe(false);
});

test("new panels take an id after the largest one", () => {
  expect(nextPanelId([])).toBe("1");
  expect(nextPanelId([{ id: "4" }, { id: "2" }])).toBe("5");
});

test("a panel draws a distribution of one column, a scatter of two, a 3D scatter of three", () => {
  expect(scatterKind({ id: "1", x: null, y: null, z: null })).toBe("empty");
  expect(scatterKind({ id: "1", x: "a", y: null, z: null })).toBe("distribution");
  expect(scatterKind({ id: "1", x: null, y: null, z: "c" })).toBe("distribution");
  expect(scatterKind({ id: "1", x: "a", y: "b", z: null })).toBe("xy");
  expect(scatterKind({ id: "1", x: null, y: "b", z: "c" })).toBe("xy");
  expect(scatterKind({ id: "1", x: "a", y: "b", z: "c" })).toBe("xyz");
});

test("the set axes are plotted in X, Y, Z order, whichever are None", () => {
  expect(plottedColumns({ id: "1", x: null, y: "b", z: "c" })).toEqual(["b", "c"]);
  expect(plottedColumns({ id: "1", x: "a", y: null, z: "c" })).toEqual(["a", "c"]);
  expect(plottedColumns({ id: "1", x: null, y: "b", z: null })).toEqual(["b"]);
  expect(plottedColumns({ id: "1", x: null, y: null, z: null })).toEqual([]);
});

test("unknown columns are dropped and the other axes keep their columns", () => {
  const columns = new Set(["a", "b", "c"]);
  expect(normalizeScatterPanel({ id: "1", x: "gone", y: "b", z: "c" }, columns)).toEqual({
    id: "1",
    x: null,
    y: "b",
    z: "c",
  });
  expect(normalizeScatterPanel({ id: "1", x: "a", y: "gone", z: "c" }, columns)).toEqual({
    id: "1",
    x: "a",
    y: null,
    z: "c",
  });
});

describe("distribution plots saved by older pages", () => {
  test("saved distribution panels move over by column", () => {
    expect(
      distributionAxesToMigrate(
        {
          panels: [
            { id: "1", axis: "lr" },
            { id: "2", axis: null },
            { id: "3", axis: "optimizer" },
          ],
          axis: "ignored",
        },
        "also ignored",
      ),
    ).toEqual(["lr", "optimizer"]);
  });

  test("the single axis of older pages moves over", () => {
    expect(distributionAxesToMigrate({ panels: undefined, axis: "lr" }, null)).toEqual(["lr"]);
  });

  test("the axis an experiment asked for applies only while nothing is saved", () => {
    const requested = "c";
    expect(distributionAxesToMigrate({ panels: undefined, axis: undefined }, requested)).toEqual([
      "c",
    ]);
    // An emptied list records that the columns already moved.
    expect(distributionAxesToMigrate({ panels: [], axis: undefined }, requested)).toEqual([]);
    expect(distributionAxesToMigrate({ panels: undefined, axis: undefined }, 7)).toEqual([]);
  });

  test("columns become one-axis panels unless they already have one", () => {
    const panels = [
      { id: "1", x: "lr", y: "loss", z: null },
      { id: "2", x: "optimizer", y: null, z: null },
      { id: "3", x: null, y: null, z: "seed" },
    ];
    expect(withOneAxisPanels(panels, ["lr", "optimizer", "seed"])).toEqual([
      ...panels,
      { id: "4", x: "lr", y: null, z: null },
    ]);
  });
});
