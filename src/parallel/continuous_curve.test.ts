import { expect, test } from "bun:test";
import { continuousCurve } from "./continuous_curve";
import { continuousStripCoverage, evaluateContinuousPixel } from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import type { ContinuousRequest } from "./continuous_types";

test("the inverse profile and its screen derivative match independent parametric samples", () => {
  for (let index = 0; index <= 1000; ++index) {
    const s = index / 1000;
    const x = 1.5 * s * (1 - s) + s ** 3;
    const [weight, derivative] = continuousCurve(x);
    expect(weight).toBeCloseTo(3 * s ** 2 - 2 * s ** 3, 12);
    expect(derivative).toBeCloseTo((6 * s * (1 - s)) / (1.5 - 3 * s + 3 * s ** 2), 12);
  }
  expect(continuousCurve(0)).toEqual([0, 0]);
  expect(continuousCurve(1)).toEqual([1, 0]);
});

test("pair-local curved strips follow the exact half-gap zero-slope Bezier", () => {
  const frame: ContinuousRequest = {
    id: 1,
    width: 85,
    height: 255,
    lineWidth: 1,
    pixelRatio: 1,
    curved: true,
    draft: false,
    resolution: 1,
    drawnRows: 1,
    selectedCount: 1,
    contextCount: 0,
    colorMode: "mean",
    contextColor: { r: 0, g: 0, b: 0 },
    contextAlpha: 0,
    axes: [
      { column: 1, x: 0 },
      { column: 2, x: 85 },
    ],
    columns: [
      { id: 1, pixels: Float32Array.of(0) },
      { id: 2, pixels: Float32Array.of(255) },
    ],
    colors: { bins: Uint32Array.of(0), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
    selection: Uint8Array.of(1),
  };
  const pair = new ContinuousKernel().update(frame).pairs.find((pair) => pair.key === "1:2");
  if (pair === undefined) throw new Error("Missing curve pair");
  for (const s of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) {
    const x = (1.5 * s * (1 - s) + s ** 3) * 85;
    const center = (3 * s ** 2 - 2 * s ** 3) * 255;
    const slope = (((6 * s * (1 - s)) / (1.5 - 3 * s + 3 * s ** 2)) * 255) / 85;
    for (const offset of [-0.25, 0, 0.5]) {
      const actual = evaluateContinuousPixel(pair.histogram, frame, 85, x, center + offset, true);
      expect(actual.selected).toBeCloseTo(continuousStripCoverage(offset, slope, 1), 8);
    }
  }
});
