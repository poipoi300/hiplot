import { expect, test } from "bun:test";
import {
  DEFAULT_ORBIT,
  eyePosition,
  panOrbit,
  projectPoint,
  rotateOrbit,
  viewProjection,
  zoomOrbit,
} from "./orbit";

const ORIGIN = [0, 0, 0] as const;

test("the center of the cube projects to the center of the viewport", () => {
  const matrix = viewProjection(DEFAULT_ORBIT, 2);
  const center = projectPoint(matrix, 0, 0, 0, 800, 400);
  expect(center?.x).toBeCloseTo(400, 3);
  expect(center?.y).toBeCloseTo(200, 3);
});

test("up in the data is up on screen, and the camera sits at its distance", () => {
  const orbit = { yaw: 0, pitch: 0, distance: 5, target: ORIGIN };
  const matrix = viewProjection(orbit, 1);
  const top = projectPoint(matrix, 0, 1, 0, 400, 400);
  expect(top?.y).toBeLessThan(200);
  expect(Math.hypot(...eyePosition(orbit))).toBeCloseTo(5);
  // Looking down -z from +z: +x is on the right.
  expect(projectPoint(matrix, 1, 0, 0, 400, 400)?.x).toBeGreaterThan(200);
});

test("points behind the camera are not projected", () => {
  const matrix = viewProjection({ yaw: 0, pitch: 0, distance: 3, target: ORIGIN }, 1);
  expect(projectPoint(matrix, 0, 0, 10, 400, 400)).toBeNull();
});

test("dragging rotates with the pitch held short of the poles, the wheel zooms within bounds", () => {
  const rotated = rotateOrbit(DEFAULT_ORBIT, 100, 1000);
  expect(rotated.yaw).toBeCloseTo(DEFAULT_ORBIT.yaw - 1);
  expect(rotated.pitch).toBe(1.45);
  expect(zoomOrbit(DEFAULT_ORBIT, -100000).distance).toBe(1.2);
  expect(zoomOrbit(DEFAULT_ORBIT, 100000).distance).toBe(12);
  expect(zoomOrbit(DEFAULT_ORBIT, 100).distance).toBeGreaterThan(DEFAULT_ORBIT.distance);
});

test("panning moves what is under the pointer along with it", () => {
  const before = viewProjection(DEFAULT_ORBIT, 1);
  const center = projectPoint(before, 0, 0, 0, 400, 400);
  const panned = panOrbit(DEFAULT_ORBIT, 40, -25, 400);
  const after = projectPoint(viewProjection(panned, 1), 0, 0, 0, 400, 400);
  expect((after?.x ?? 0) - (center?.x ?? 0)).toBeCloseTo(40, 0);
  expect((after?.y ?? 0) - (center?.y ?? 0)).toBeCloseTo(-25, 0);
  expect(panned.distance).toBe(DEFAULT_ORBIT.distance);
  // The target stays near the cube however far the pointer goes.
  expect(Math.max(...panOrbit(DEFAULT_ORBIT, 1e6, 0, 400).target.map(Math.abs))).toBe(2);
});
