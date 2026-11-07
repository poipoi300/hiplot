import { expect, test } from "bun:test";
import { infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import type { Datapoint } from "../types";
import { labelEdges, scatterPositions } from "./scatter3d";

const rows: Datapoint[] = [
  { uid: "a", from_uid: null, x: 0, y: 10, z: "adam" },
  { uid: "b", from_uid: null, x: 5, y: 20, z: "sgd" },
  { uid: "c", from_uid: null, x: 10, y: "inf", z: "adam" },
];

test("rows are placed in the [-1, 1] cube, missing values as NaN", () => {
  const params_def = infertypes(new PersistentStateInMemory("", {}), rows);
  const positions = scatterPositions(rows, params_def, { x: "x", y: "y", z: "z" });
  expect(Array.from(positions.slice(0, 3))).toEqual([-1, -1, positions[2]]);
  expect(positions[3]).toBeCloseTo(0);
  expect(positions[4]).toBe(1);
  expect(Number.isNaN(positions[7])).toBe(true);
  expect(positions[2]).not.toBe(positions[5]);
  expect(positions[2]).toBe(positions[8]);
});

test("X and Z are labelled along the bottom edges facing the camera", () => {
  // The vertical edge at x = -1 is further left on screen.
  const edges = labelEdges([3, 2, -4], (point) => point[0]);
  expect(edges.x(0.5, 1)).toEqual([0.5, -1, -1]);
  expect(edges.z(0.5, 1)).toEqual([1, -1, 0.5]);
  expect(edges.y(0.5, 1)).toEqual([-1, 0.5, -1]);
});
