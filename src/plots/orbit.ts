/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The camera of the 3D scatter: it orbits the center of the [-1, 1]^3 data
 * cube, `yaw` around the vertical axis and `pitch` above the horizontal
 * plane (radians), `distance` away from it. Matrices are column-major, as
 * WebGL takes them.
 */
export interface Orbit {
  yaw: number;
  pitch: number;
  distance: number;
}

export const DEFAULT_ORBIT: Orbit = { yaw: -0.65, pitch: 0.42, distance: 5.8 };
const MAX_PITCH = 1.45;
const MIN_DISTANCE = 2.2;
const MAX_DISTANCE = 12;
/** Vertical field of view, in radians. */
const FIELD_OF_VIEW = 0.7;

/** The orbit after a drag of (dx, dy) pixels: pitch stays short of the poles. */
export function rotateOrbit(orbit: Orbit, dx: number, dy: number): Orbit {
  return {
    ...orbit,
    yaw: orbit.yaw - dx * 0.01,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, orbit.pitch + dy * 0.01)),
  };
}

/** The orbit after a wheel turn: distance scales exponentially, within bounds. */
export function zoomOrbit(orbit: Orbit, deltaY: number): Orbit {
  const distance = orbit.distance * Math.exp(deltaY * 0.0015);
  return { ...orbit, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance)) };
}

type Vector = readonly [number, number, number];

const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vector): Vector => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Where the camera is. */
export function eyePosition(orbit: Orbit): Vector {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  return [
    flat * Math.sin(orbit.yaw),
    Math.sin(orbit.pitch) * orbit.distance,
    flat * Math.cos(orbit.yaw),
  ];
}

/** Projection times view matrix of the orbit for a viewport of the given aspect ratio. */
export function viewProjection(orbit: Orbit, aspect: number): Float32Array {
  const eye = eyePosition(orbit);
  const forward = normalize(subtract([0, 0, 0], eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const view = [
    right[0],
    up[0],
    -forward[0],
    0,
    right[1],
    up[1],
    -forward[1],
    0,
    right[2],
    up[2],
    -forward[2],
    0,
    -dot(right, eye),
    -dot(up, eye),
    dot(forward, eye),
    1,
  ];
  const near = 0.1;
  const far = 50;
  const f = 1 / Math.tan(FIELD_OF_VIEW / 2);
  const projection = [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
  const result = new Float32Array(16);
  for (let column = 0; column < 4; ++column) {
    for (let row = 0; row < 4; ++row) {
      let sum = 0;
      for (let k = 0; k < 4; ++k) {
        sum += projection[k * 4 + row] * view[column * 4 + k];
      }
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

/** Pixel position of a point in a viewport of `width` x `height`; null behind the camera. */
export function projectPoint(
  matrix: Float32Array,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (w <= 0) {
    return null;
  }
  const clipX = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const clipY = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  return { x: ((clipX + 1) / 2) * width, y: ((1 - clipY) / 2) * height };
}
