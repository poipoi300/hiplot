/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * How per-row arrays are laid out in WebGL textures: row `i` lives at texel
 * (i % width, i / width). Data columns of the pixels texture stack vertically,
 * each spanning `rowsPerColumn` texture rows.
 */
export interface TextureLayout {
  width: number;
  /** Texture rows one per-row array occupies. */
  rowsPerColumn: number;
}

/** Stand-in for "no position" in float textures; shaders test `y < MISSING_THRESHOLD`. */
export const MISSING_PIXEL = -1.0e30;
export const MISSING_THRESHOLD = -1.0e29;

/** Widest texture used, within what every WebGL2 implementation supports. */
export const MAX_TEXTURE_WIDTH = 2048;

export function textureLayout(rowCount: number, maxTextureSize: number): TextureLayout {
  const width = Math.max(1, Math.min(MAX_TEXTURE_WIDTH, maxTextureSize, rowCount));
  return { width, rowsPerColumn: Math.max(1, Math.ceil(rowCount / width)) };
}

/** A per-row pixel column padded to the layout, with NaN replaced by MISSING_PIXEL. */
export function encodePixelColumn(pixels: Float32Array, layout: TextureLayout): Float32Array {
  const encoded = new Float32Array(layout.width * layout.rowsPerColumn);
  for (let i = 0; i < pixels.length; ++i) {
    const y = pixels[i];
    encoded[i] = Number.isNaN(y) ? MISSING_PIXEL : y;
  }
  return encoded;
}

/** A per-row integer array padded to the layout. */
export function padUint32(values: ArrayLike<number>, layout: TextureLayout): Uint32Array {
  const padded = new Uint32Array(layout.width * layout.rowsPerColumn);
  for (let i = 0; i < values.length; ++i) {
    padded[i] = values[i];
  }
  return padded;
}

/** A per-row 0/1 mask padded to the layout. */
export function padUint8(values: ArrayLike<number>, layout: TextureLayout): Uint8Array {
  const padded = new Uint8Array(layout.width * layout.rowsPerColumn);
  for (let i = 0; i < values.length; ++i) {
    padded[i] = values[i];
  }
  return padded;
}

/** Segments drawn per line: one between each pair of axes, plus a stub at each end. */
export function segmentsPerLine(axisCount: number): number {
  return axisCount + 1;
}
