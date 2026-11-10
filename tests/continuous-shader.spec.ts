import { loadParallelBenchmark } from "../bench/parallel";
import type { ColorMode } from "../src/lib/colors";
import { evaluateContinuousPairCPU } from "../src/parallel/continuous_density";
import { ContinuousKernel } from "../src/parallel/continuous_grid";
import type { ContinuousImage, ContinuousRequest } from "../src/parallel/continuous_types";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

for (const { dense, curved, mode, numeric, paletteSize = 3 } of [
  { dense: false, curved: false, mode: "mean", numeric: true },
  { dense: false, curved: true, mode: "highest", numeric: true },
  { dense: true, curved: false, mode: "lowest", numeric: true },
  { dense: true, curved: true, mode: "mean", numeric: true },
  { dense: true, curved: false, mode: "mean", numeric: false },
  { dense: false, curved: true, mode: "mean", numeric: false, paletteSize: 20_000 },
] as readonly {
  dense: boolean;
  curved: boolean;
  mode: ColorMode;
  numeric: boolean;
  paletteSize?: number;
}[]) {
  test(`histogram shader agrees with CPU for ${dense ? "dense" : "sparse"} ${curved ? "eased" : "straight"} ${numeric ? mode : "RGB"}`, async ({
    page,
  }) => {
    const rows = dense ? 600 : 12;
    const left = Float32Array.from({ length: rows }, (_, row) =>
      dense ? Math.floor(row / 25) + 0.25 : ((row * 7) % 24) + 0.25,
    );
    const right = Float32Array.from({ length: rows }, (_, row) =>
      dense ? (row % 25) * 0.94 : ((row * 11) % 24) + 0.25,
    );
    left[2] = Number.NaN;
    right[3] = Number.NaN;
    left[4] = Number.NaN;
    right[4] = Number.NaN;
    const selection = Uint8Array.from({ length: rows }, (_, row) => Number(row % 4 !== 0));
    const basePalette = [
      { r: 34, g: 100, b: 220 },
      { r: 240, g: 170, b: 30 },
      { r: 150, g: 30, b: 120 },
    ];
    const colors: LineColors = {
      bins: Uint32Array.from({ length: rows }, (_, row) => row % 3),
      palette: Array.from({ length: paletteSize }, (_, index) => basePalette[index % 3]),
      colorMapBins: numeric ? 2 : 0,
    };
    if (paletteSize > 3) colors.bins[1] = paletteSize - 1;
    const frame: Omit<LineFrame, "axes"> = {
      width: 32,
      height: 24,
      lineWidth: 1,
      pixelRatio: 1,
      curved,
      draft: false,
      resolution: 1,
      drawnRows: rows,
      selectedCount: selection.reduce((sum, value) => sum + value, 0),
      contextCount: selection.reduce((sum, value) => sum + 1 - value, 0),
      contextColor: { r: 120, g: 130, b: 140 },
      contextAlpha: 0.2,
      colorMode: mode as ColorMode,
    };
    const request: ContinuousRequest = {
      ...frame,
      id: 1,
      axes: [
        { column: 1, x: 0 },
        { column: 2, x: 32 },
      ],
      columns: [
        { id: 1, pixels: left },
        { id: 2, pixels: right },
      ],
      selection,
      colors,
    };
    const update = new ContinuousKernel().update(request);
    const pair = update.pairs.find((pair) => pair.left.column === 1 && pair.right.column === 2);
    if (!pair) throw new Error("No reference pair");
    const expected = evaluateContinuousPairCPU(pair, request, update);
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: true, seed: 20261109 },
      "low",
    );
    const before = await page.evaluate(
      ({ left, right, selection, colors, frame }) => {
        interface Plot {
          continuousFrame: number;
          continuous: { draw: (frame: LineFrame, colors: LineColors, mask: Uint8Array) => void };
        }
        const p = (
          window as unknown as { __parallelProbe: { instance: { parallelPlot: () => Plot } } }
        ).__parallelProbe.instance.parallelPlot();
        p.continuous.draw(
          {
            ...frame,
            axes: [
              { x: 0, pixels: new Float32Array(left) },
              { x: 32, pixels: new Float32Array(right) },
            ],
          },
          { ...colors, bins: new Uint32Array(colors.bins) },
          new Uint8Array(selection),
        );
        return p.continuousFrame;
      },
      {
        left: Array.from(left),
        right: Array.from(right),
        selection: Array.from(selection),
        colors: { ...colors, bins: Array.from(colors.bins) },
        frame,
      },
    );
    await Promise.race([
      page.waitForFunction((before) => {
        const p = (
          window as unknown as {
            __parallelProbe: {
              instance: {
                parallelPlot: () => { continuousFrame: number; continuous: { busy: boolean } };
              };
            };
          }
        ).__parallelProbe.instance.parallelPlot();
        return p.continuousFrame > before && !p.continuous.busy;
      }, before),
      page.waitForEvent("pageerror").then((error) => {
        throw error;
      }),
    ]);
    const actual = await page.evaluate(() => {
      const image = (
        window as unknown as {
          __parallelProbe: {
            instance: { parallelPlot: () => { continuousMetrics: ContinuousImage } };
          };
        }
      ).__parallelProbe.instance.parallelPlot().continuousMetrics;
      return {
        pixels: Array.from(image.pixels),
        width: image.width,
        height: image.height,
        rows: image.rows,
      };
    });
    expect(actual.width).toBe(expected.width);
    expect(actual.height).toBe(expected.height);
    expect(actual.rows).toBe(rows);
    let maximum = 0;
    let energy = 0;
    let absolute = 0;
    for (let channel = 0; channel < expected.pixels.length; ++channel) {
      const alpha = channel - (channel % 4) + 3;
      const reference =
        channel % 4 === 3
          ? expected.pixels[channel]
          : (expected.pixels[channel] * expected.pixels[alpha]) / 255;
      const candidate =
        channel % 4 === 3
          ? actual.pixels[channel]
          : (actual.pixels[channel] * actual.pixels[alpha]) / 255;
      const error = Math.abs(candidate - reference);
      maximum = Math.max(maximum, error);
      absolute += error;
      energy += reference;
    }
    expect(energy).toBeGreaterThan(1000);
    await test.info().attach("shader-reference", {
      body: JSON.stringify({ maximum, absolute, channels: expected.pixels.length }),
      contentType: "application/json",
    });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(absolute / expected.pixels.length).toBeLessThanOrEqual(0.25);
  });
}
