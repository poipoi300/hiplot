import { describe, expect, test } from "bun:test";
import {
  encodePixelColumn,
  MAX_TEXTURE_WIDTH,
  MISSING_PIXEL,
  padUint8,
  padUint32,
  pixelTextureCapacity,
  segmentsPerLine,
  textureLayout,
} from "./webgl_layout";

describe("texture layout", () => {
  test("small row counts fit in one texture row", () => {
    expect(textureLayout(100, 16384)).toEqual({ width: 100, rowsPerColumn: 1 });
  });

  test("large row counts wrap at the maximum width", () => {
    expect(textureLayout(50_000, 16384)).toEqual({
      width: MAX_TEXTURE_WIDTH,
      rowsPerColumn: Math.ceil(50_000 / MAX_TEXTURE_WIDTH),
    });
    expect(textureLayout(5000, 1024).width).toBe(1024);
  });

  test("an empty dataset still gets a valid texture", () => {
    expect(textureLayout(0, 16384)).toEqual({ width: 1, rowsPerColumn: 1 });
  });
});

describe("pixel texture capacity", () => {
  test("spare slots retain geometric growth when the device can fit them", () => {
    expect(pixelTextureCapacity(3, 1, 16384)).toBe(8);
    expect(pixelTextureCapacity(10, 49, 8192)).toBe(20);
  });

  test("one million rows fit ten columns without reserving twenty slots", () => {
    const layout = textureLayout(1_000_000, 8192);
    expect(layout.rowsPerColumn).toBe(489);
    expect(pixelTextureCapacity(10, layout.rowsPerColumn, 8192)).toBe(16);
    expect(pixelTextureCapacity(10, 5, 64)).toBe(12);
  });

  test("actual columns that exceed the device height are still rejected", () => {
    expect(() => pixelTextureCapacity(17, 489, 8192)).toThrow(
      "Too many columns for one WebGL texture (17)",
    );
    expect(() => pixelTextureCapacity(1, 65, 64)).toThrow(
      "Too many columns for one WebGL texture (1)",
    );
  });
});

describe("texture encoding", () => {
  const layout = textureLayout(3, 2);

  test("pixel columns pad to the layout and mark missing values", () => {
    const encoded = encodePixelColumn(new Float32Array([1, Number.NaN, 3]), layout);
    expect(Array.from(encoded)).toEqual([1, Math.fround(MISSING_PIXEL), 3, 0]);
  });

  test("integer and flag arrays pad with zeros", () => {
    expect(Array.from(padUint32([7, 8, 9], layout))).toEqual([7, 8, 9, 0]);
    expect(Array.from(padUint8([1, 0, 1], layout))).toEqual([1, 0, 1, 0]);
  });

  test("each line has one segment per axis gap plus two end stubs", () => {
    expect(segmentsPerLine(5)).toBe(6);
  });
});
