import { expect, test } from "bun:test";
import {
  isDistributionPanels,
  isScatterPanels,
  nextPanelId,
  normalizeScatterPanel,
  scatterKind,
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

test("a panel draws a distribution of X alone, a scatter with Y, a 3D scatter with Z", () => {
  expect(scatterKind({ id: "1", x: null, y: null, z: null })).toBe("empty");
  expect(scatterKind({ id: "1", x: "a", y: null, z: null })).toBe("distribution");
  expect(scatterKind({ id: "1", x: "a", y: "b", z: null })).toBe("xy");
  expect(scatterKind({ id: "1", x: "a", y: "b", z: "c" })).toBe("xyz");
});

test("unknown columns are dropped, and each coordinate needs the previous one", () => {
  const columns = new Set(["a", "b", "c"]);
  expect(normalizeScatterPanel({ id: "1", x: "a", y: "gone", z: "c" }, columns)).toEqual({
    id: "1",
    x: "a",
    y: null,
    z: null,
  });
  expect(normalizeScatterPanel({ id: "1", x: "a", y: "b", z: "c" }, columns).z).toBe("c");
});
