import { expect, test } from "bun:test";
import {
  ContinuousDensityEvaluator,
  type ContinuousPixel,
  compositeContinuousPixel,
  continuousStripCoverage,
} from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import { COLOR_CHANNEL_SCALE, type ContinuousRequest, EMPTY_COLOR_KEY } from "./continuous_types";

function request(): ContinuousRequest {
  return {
    id: 1,
    width: 80,
    height: 255,
    lineWidth: 1,
    pixelRatio: 1,
    curved: true,
    draft: false,
    resolution: 1,
    drawnRows: 4,
    selectedCount: 3,
    contextCount: 1,
    colorMode: "mean",
    contextColor: { r: 0, g: 255, b: 0 },
    contextAlpha: 0.35,
    axes: [
      { column: 1, x: 20 },
      { column: 2, x: 60 },
    ],
    columns: [
      { id: 1, pixels: Float32Array.of(10.1, 10.4, 11.2, Number.NaN) },
      { id: 2, pixels: Float32Array.of(20.1, 20.4, 21.2, Number.NaN) },
    ],
    colors: {
      bins: Uint32Array.of(0, 1, 0, 1),
      palette: [
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 },
      ],
      colorMapBins: 0,
    },
    selection: Uint8Array.of(1, 0, 1, 1),
  };
}

test("outer strips retain original endpoint coverage, colors and flat 15px support", () => {
  const frame = request();
  const update = new ContinuousKernel().update(frame);
  const evaluator = new ContinuousDensityEvaluator({ gl: null });
  const image = evaluator.render(frame, update);
  if (!frame.colors || !frame.selection) throw new Error("Missing marginal fixture");
  for (const [axis, start, end] of [
    [0, 5, 20],
    [1, 60, 75],
  ]) {
    for (let y = 0; y < 32; ++y) {
      const pixel: ContinuousPixel = {
        selected: 0,
        context: 0,
        selectedPeak: 0,
        contextPeak: 0,
        color0: 0,
        color1: 0,
        color2: 0,
        winner: EMPTY_COLOR_KEY,
        winnerCoverage: 0,
      };
      for (let row = 0; row < frame.selection.length; ++row) {
        const endpoint = frame.columns[axis].pixels[row];
        if (!Number.isFinite(endpoint)) continue;
        const coverage = continuousStripCoverage(y + 0.5 - endpoint, 0, frame.lineWidth);
        if (frame.selection[row] === 0) {
          pixel.context += coverage;
          pixel.contextPeak = Math.max(pixel.contextPeak, coverage);
        } else {
          pixel.selected += coverage;
          pixel.selectedPeak = Math.max(pixel.selectedPeak, coverage);
          const color = frame.colors.palette[frame.colors.bins[row]];
          pixel.color0 += Math.round((color.r / 255) * COLOR_CHANNEL_SCALE) * coverage;
          pixel.color1 += Math.round((color.g / 255) * COLOR_CHANNEL_SCALE) * coverage;
          pixel.color2 += Math.round((color.b / 255) * COLOR_CHANNEL_SCALE) * coverage;
        }
      }
      const expected = Uint8ClampedArray.from(
        compositeContinuousPixel(
          pixel,
          frame,
          frame.colors,
          update.selectedCount,
          update.contextCount,
        ),
        (channel) => channel * 255,
      );
      for (let x = start; x < end; ++x) {
        const offset = (y * image.width + x) * 4;
        expect(image.pixels.slice(offset, offset + 4)).toEqual(expected);
      }
      for (const x of [4, 75]) expect(image.pixels[(y * image.width + x) * 4 + 3]).toBe(0);
    }
  }
  evaluator.dispose();
});

test("within-bin selection exchanges invalidate original-endpoint marginal caches", () => {
  const frame = request();
  frame.colors = { bins: new Uint32Array(4), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 };
  frame.selection = Uint8Array.of(1, 0, 0, 0);
  const kernel = new ContinuousKernel();
  const evaluator = new ContinuousDensityEvaluator({ gl: null });
  const beforeUpdate = kernel.update(frame);
  const before = evaluator.render(frame, beforeUpdate);
  const next = {
    ...frame,
    id: 2,
    columns: [],
    colors: undefined,
    selection: Uint8Array.of(0, 1, 0, 0),
  };
  const afterUpdate = kernel.update(next);
  expect(afterUpdate.pairs[0].histogram.revision).toBe(beforeUpdate.pairs[0].histogram.revision);
  const after = evaluator.render(next, afterUpdate);
  const alpha = (image: typeof before) => image.pixels[(9 * image.width + 10) * 4 + 3];
  expect(alpha(before)).toBeGreaterThan(alpha(after));
  expect(after.evaluatedPairs).toBe(2);
  const scrolled = evaluator.render(
    { ...next, id: 3, axes: next.axes.map((axis) => ({ ...axis, x: axis.x + 0.25 })) },
    kernel.update({ ...next, id: 3, selection: undefined }),
  );
  expect(scrolled.evaluatedPairs).toBe(0);
  evaluator.dispose();
});

for (const colorMode of ["mean", "lowest", "highest"] as const) {
  for (const lineWidth of [0.5, 1, 2.5]) {
    test(`outer numeric ${colorMode} colors retain missing mass at width ${lineWidth}`, () => {
      const frame = request();
      frame.colorMode = colorMode;
      frame.lineWidth = lineWidth;
      frame.columns[0].pixels[3] = 10.2;
      frame.colors = {
        bins: Uint32Array.of(0, 2, 3, 1),
        colorMapBins: 3,
        palette: [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
          { r: 255, g: 0, b: 255 },
        ],
      };
      frame.selection = Uint8Array.of(1, 0, 1, 1);
      const update = new ContinuousKernel().update(frame);
      const evaluator = new ContinuousDensityEvaluator({ gl: null });
      const image = evaluator.render(frame, update);
      for (let y = 7; y < 15; ++y) {
        const pixel: ContinuousPixel = {
          selected: 0,
          context: 0,
          selectedPeak: 0,
          contextPeak: 0,
          color0: 0,
          color1: 0,
          color2: 0,
          winner: EMPTY_COLOR_KEY,
          winnerCoverage: 0,
        };
        for (let row = 0; row < 4; ++row) {
          const coverage = continuousStripCoverage(
            y + 0.5 - frame.columns[0].pixels[row],
            0,
            lineWidth,
          );
          if (coverage <= 0) continue;
          if (frame.selection[row] === 0) {
            pixel.context += coverage;
            pixel.contextPeak = Math.max(pixel.contextPeak, coverage);
            continue;
          }
          pixel.selected += coverage;
          pixel.selectedPeak = Math.max(pixel.selectedPeak, coverage);
          const rank = frame.colors.bins[row];
          if (rank === 3) {
            pixel.color1 += coverage;
            continue;
          }
          pixel.color0 += rank * coverage;
          if (colorMode !== "mean") {
            if (
              pixel.winner === EMPTY_COLOR_KEY ||
              (colorMode === "lowest" ? rank < pixel.winner : rank > pixel.winner)
            ) {
              pixel.winner = rank;
              pixel.winnerCoverage = coverage;
            } else if (rank === pixel.winner)
              pixel.winnerCoverage = Math.max(pixel.winnerCoverage, coverage);
          }
        }
        const expected = Uint8ClampedArray.from(
          compositeContinuousPixel(
            pixel,
            frame,
            frame.colors,
            update.selectedCount,
            update.contextCount,
          ),
          (channel) => channel * 255,
        );
        const offset = (y * image.width + 10) * 4;
        expect(image.pixels.slice(offset, offset + 4)).toEqual(expected);
      }
      evaluator.dispose();
    });
  }
}
