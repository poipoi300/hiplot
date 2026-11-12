import { loadParallelBenchmark } from "../bench/parallel";
import { evaluateContinuousPairCPU } from "../src/parallel/continuous_density";
import { ContinuousKernel } from "../src/parallel/continuous_grid";
import type { ContinuousImage, ContinuousRequest } from "../src/parallel/continuous_types";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface WarmWindow {
  __histogramFrame?: LineFrame;
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousFrame: number;
        continuousMetrics: ContinuousImage;
        continuous: {
          busy: boolean;
          draw: (frame: LineFrame, colors: LineColors, mask: Uint8Array) => void;
        };
      };
    };
  };
}

for (const pixelRatio of [1, 1.25, 3]) {
  test(`warm histogram uploads preserve pixels at DPR ${pixelRatio} through selection and style changes`, async ({
    page,
  }) => {
    const rows = 3000;
    const left = Float32Array.from(
      { length: rows },
      (_, row) => Math.floor((row % 2400) / 50) * 0.5 + 0.25,
    );
    const right = Float32Array.from({ length: rows }, (_, row) => (row % 50) * 0.47);
    const kernel = new ContinuousKernel();
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: true, seed: 20261109 },
      "low",
    );
    for (let revision = 0; revision < 5; ++revision) {
      const selection = Uint8Array.from({ length: rows }, (_, row) =>
        Number((row + revision) % 4 !== 0),
      );
      const colors: LineColors = {
        bins: Uint32Array.from({ length: rows }, (_, row) => (row + revision) % 3),
        palette: [
          { r: 34 + revision * 20, g: 100, b: 220 },
          { r: 240, g: 170, b: 30 },
          { r: 150, g: 30, b: 120 },
        ],
        colorMapBins: revision === 3 ? 0 : 2,
      };
      const frame: Omit<LineFrame, "axes"> = {
        width: 32,
        height: 24,
        lineWidth: 1,
        pixelRatio,
        curved: false,
        draft: false,
        resolution: 1,
        drawnRows: rows,
        selectedCount: selection.reduce((sum, value) => sum + value, 0),
        contextCount: selection.reduce((sum, value) => sum + 1 - value, 0),
        contextColor: { r: 120, g: 130, b: 140 },
        contextAlpha: 0.2,
        colorMode: revision === 2 ? "highest" : "mean",
      };
      const request: ContinuousRequest = {
        ...frame,
        id: revision + 1,
        axes: [
          { column: 1, x: 0 },
          { column: 2, x: 32 },
        ],
        columns:
          revision === 0
            ? [
                { id: 1, pixels: left },
                { id: 2, pixels: right },
              ]
            : [],
        selection,
        colors,
      };
      const update = kernel.update(request);
      const pair = update.pairs.find((pair) => pair.left.column === 1 && pair.right.column === 2);
      if (!pair) throw new Error("Missing reference histogram");
      const expected = evaluateContinuousPairCPU(
        pair,
        request,
        update,
        Math.ceil(32 * pixelRatio),
        false,
      );
      const before = await page.evaluate(
        ({ frame, left, right, colors, selection }) => {
          const win = window as unknown as WarmWindow;
          const plot = win.__parallelProbe.instance.parallelPlot();
          win.__histogramFrame = {
            ...frame,
            axes: win.__histogramFrame?.axes ?? [
              { x: 0, pixels: new Float32Array(left) },
              { x: 32, pixels: new Float32Array(right) },
            ],
          };
          plot.continuous.draw(
            win.__histogramFrame,
            { ...colors, bins: new Uint32Array(colors.bins) },
            new Uint8Array(selection),
          );
          return plot.continuousFrame;
        },
        {
          frame,
          left: Array.from(left),
          right: Array.from(right),
          colors: { ...colors, bins: Array.from(colors.bins) },
          selection: Array.from(selection),
        },
      );
      await page.waitForFunction((before) => {
        const plot = (window as unknown as WarmWindow).__parallelProbe.instance.parallelPlot();
        return plot.continuousFrame > before && !plot.continuous.busy;
      }, before);
      const actual = await page.evaluate(() => {
        const image = (window as unknown as WarmWindow).__parallelProbe.instance.parallelPlot()
          .continuousMetrics;
        return { pixels: Array.from(image.pixels), width: image.width, height: image.height };
      });
      expect(actual.width).toBe(expected.width);
      expect(actual.height).toBe(expected.height);
      let maximum = 0;
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
      }
      expect(maximum).toBeLessThanOrEqual(2);
      expect(absolute / expected.pixels.length).toBeLessThanOrEqual(0.25);
    }
  });
}
