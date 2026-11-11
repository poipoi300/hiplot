import { loadParallelBenchmark } from "../bench/parallel";
import type { ColorMode } from "../src/lib/colors";
import type { LineGeometry } from "../src/parallel/geometry";
import type { LineColors, LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface PicturePlot {
  webgl: WebGLLineRenderer;
  exact: { busy: boolean };
  foreground_ref: { current: HTMLCanvasElement };
  exact_image_ref: { current: HTMLCanvasElement };
  geometry: () => LineGeometry;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
  drawExactWorker: (
    frame: LineFrame,
    geometry: LineGeometry,
    colors: LineColors,
    mask: Uint8Array,
  ) => boolean;
}

test("exact lines still render when worker canvases are unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "OffscreenCanvas", { value: undefined, configurable: true });
  });
  await loadParallelBenchmark(
    page,
    { rows: 20_001, columns: 2, discrete: false, seed: 20261109 },
    "full",
  );
  const result = await page.evaluate(() => {
    const plot = (
      window as unknown as { __parallelProbe: { instance: { parallelPlot: () => PicturePlot } } }
    ).__parallelProbe.instance.parallelPlot();
    return {
      worker: plot.exact !== null,
      foreground: plot.foreground_ref.current.style.visibility,
      bitmap: plot.exact_image_ref.current.style.visibility,
    };
  });
  expect(result).toEqual({ worker: false, foreground: "visible", bitmap: "hidden" });
});

for (const numeric of [true, false]) {
  test(`completed exact worker images preserve ${numeric ? "numeric" : "categorical"} line pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await loadParallelBenchmark(
      page,
      { rows: 2048, columns: 3, discrete: false, seed: 20261109 },
      "full",
    );
    const results = await page.evaluate(async (numeric) => {
      const plot = (
        window as unknown as { __parallelProbe: { instance: { parallelPlot: () => PicturePlot } } }
      ).__parallelProbe.instance.parallelPlot();
      const geometry = plot.geometry();
      const mask = Uint8Array.from(geometry.order, (_, row) => Number(row % 3 !== 0));
      const source = plot.lineFrame(geometry, mask);
      const colors: LineColors = {
        bins: Uint32Array.from(geometry.order, (_, row) => row % 13),
        palette: Array.from({ length: 13 }, (_, bin) => ({
          r: (bin * 79) % 256,
          g: (bin * 37) % 256,
          b: (bin * 113) % 256,
        })),
        colorMapBins: numeric ? 12 : 0,
      };
      const capture = (canvas: HTMLCanvasElement) => {
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext("2d");
        if (!context) throw new Error("Missing pixel comparison context");
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height).data;
      };
      const results: { mode: string; maximum: number; mean: number; ink: number }[] = [];
      for (const colorMode of ["mean", "lowest", "highest"] as ColorMode[]) {
        for (const curved of [false, true]) {
          const frame: LineFrame = {
            ...source,
            curved,
            draft: !curved,
            colorMode,
            axes: source.axes.map((axis, index) => ({
              ...axis,
              pixels: Float32Array.from(axis.pixels, (y, row) =>
                index === 1 && row % 17 === 0 ? -1e30 : y,
              ),
            })),
          };
          if (!plot.drawExactWorker(frame, geometry, colors, mask))
            throw new Error("Missing exact worker support");
          while (plot.exact.busy) await new Promise(requestAnimationFrame);
          const worker = capture(plot.exact_image_ref.current);
          plot.webgl.setRows(geometry.rows.length, geometry.order);
          plot.webgl.setDrawOrder(
            plot.webgl.densityRendering
              ? geometry.order
              : geometry.colorOrder(colors.bins, colors.colorMapBins, colorMode),
          );
          plot.webgl.setColors(colors);
          plot.webgl.setSelection(mask);
          plot.webgl.draw(frame);
          const direct = capture(plot.foreground_ref.current);
          let maximum = 0,
            sum = 0,
            ink = 0;
          for (let i = 0; i < worker.length; i += 4) {
            ink += worker[i + 3];
            for (let channel = 0; channel < 4; channel++) {
              const alpha = channel === 3;
              const difference = Math.abs(
                worker[i + channel] * (alpha ? 1 : worker[i + 3] / 255) -
                  direct[i + channel] * (alpha ? 1 : direct[i + 3] / 255),
              );
              maximum = Math.max(maximum, difference);
              sum += difference;
            }
          }
          results.push({
            mode: `${colorMode}/${curved ? "curved" : "straight draft"}`,
            maximum,
            mean: sum / worker.length,
            ink,
          });
        }
      }
      return results;
    }, numeric);
    for (const result of results) {
      expect(result.ink, result.mode).toBeGreaterThan(0);
      expect(result.maximum, result.mode).toBeLessThanOrEqual(2);
      expect(result.mean, result.mode).toBeLessThanOrEqual(0.25);
    }
  });
}
