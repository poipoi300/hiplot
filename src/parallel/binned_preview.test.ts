import { expect, test } from "bun:test";
import { BinnedPreview, PREVIEW_ROWS, PREVIEW_SCALE, previewIndices } from "./binned_preview";
import type { LineColors, LineFrame } from "./webgl";

test("stratified preview identities are stable, bounded and span the source rows", () => {
  expect(Array.from(previewIndices(4))).toEqual([0, 1, 2, 3]);
  expect(Array.from(previewIndices(0))).toEqual([]);
  const indices = previewIndices(1_000_000);
  expect(indices.length).toBe(PREVIEW_ROWS);
  expect(Array.from(indices)).toEqual(Array.from(previewIndices(1_000_000)));
  expect(new Set(indices).size).toBe(PREVIEW_ROWS);
  const stratum = Math.ceil(1_000_000 / PREVIEW_ROWS);
  expect(indices[0]).toBeLessThan(stratum);
  expect(indices[indices.length - 1]).toBeGreaterThanOrEqual(1_000_000 - stratum);
  expect(indices.every((row) => row < 1_000_000)).toBe(true);
});

test("preview geometry, colors and masks retain the same row identities without detaching source data", () => {
  const pixels = Float32Array.from({ length: 2000 }, (_, row) => row);
  pixels[3] = Number.NaN;
  const bins = Uint32Array.from({ length: 2000 }, (_, row) => row % 13);
  const selection = Uint8Array.from({ length: 2000 }, (_, row) => Number(row % 5 === 0));
  const frame: LineFrame = {
    axes: [{ x: 20, pixels }],
    width: 100,
    height: 100,
    lineWidth: 1,
    pixelRatio: 1,
    curved: false,
    draft: true,
    resolution: 1,
    drawnRows: 2000,
    selectedCount: 400,
    contextCount: 1600,
    contextColor: { r: 1, g: 2, b: 3 },
    contextAlpha: 0.2,
    colorMode: "mean",
  };
  const colors: LineColors = { bins, palette: [], colorMapBins: 0 };
  const preview = new BinnedPreview();
  const first = preview.frame(frame, colors, selection);
  const indices = previewIndices(2000);
  for (let index = 0; index < indices.length; ++index) {
    const row = indices[index];
    expect(first.frame.axes[0].pixels[index]).toBe(pixels[row] * PREVIEW_SCALE);
    expect(first.colors.bins[index]).toBe(bins[row]);
    expect(first.selection[index]).toBe(selection[row]);
  }
  expect(first.frame.width).toBe(50);
  expect(first.frame.axes[0].x).toBe(10);
  expect(first.rowWeight * indices.length).toBe(2000);
  selection.fill(0);
  const second = preview.frame(frame, colors, selection);
  expect(second.frame.axes[0].pixels).toBe(first.frame.axes[0].pixels);
  expect(second.colors.bins).toBe(first.colors.bins);
  expect(second.selection.some(Boolean)).toBe(false);
  expect(pixels.length).toBe(2000);
  expect(bins.length).toBe(2000);
  expect(() => preview.frame(frame, { ...colors, bins: bins.slice(0, 4) }, selection)).toThrow(
    "same rows",
  );
  expect(() =>
    preview.frame({ ...frame, axes: [{ x: 20, pixels: pixels.slice(0, 4) }] }, colors, selection),
  ).toThrow("same rows");
  const resized = preview.frame(
    { ...frame, axes: [{ x: 20, pixels: pixels.slice(0, 4) }] },
    { ...colors, bins: bins.slice(0, 4) },
    selection.slice(0, 4),
  );
  expect(resized.selection.length).toBe(4);
  expect(resized.rowWeight).toBe(1);
  expect(resized.frame.axes[0].pixels).not.toBe(first.frame.axes[0].pixels);
});
