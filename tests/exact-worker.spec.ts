import { loadParallelBenchmark } from "../bench/parallel";
import type { ColorMode } from "../src/lib/colors";
import type { LineGeometry } from "../src/parallel/geometry";
import type { RenderWorker } from "../src/parallel/render_worker";
import type { LineColors, LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import {
  exposeShownPixels,
  type ShownPixelsWindow,
  useDirectRenderer,
  warmParallelWorker,
} from "./plot";

interface PicturePlot {
  webgl: WebGLLineRenderer;
  worker: Pick<RenderWorker, "busy" | "drawExact"> | null;
  foreground_ref: { current: HTMLCanvasElement };
  workerCanvas: HTMLCanvasElement;
  geometry: () => LineGeometry;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
}

test("exact lines still render when worker canvases are unavailable", async ({ page }) => {
  await useDirectRenderer(page);
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
      worker: plot.worker !== null,
      foreground: plot.foreground_ref.current.style.visibility,
      workerCanvas: plot.workerCanvas.style.visibility,
    };
  });
  expect(result).toEqual({ worker: false, foreground: "visible", workerCanvas: "hidden" });
});

for (const numeric of [true, false]) {
  test(`exact lines the render worker shows preserve ${numeric ? "numeric" : "categorical"} line pixels`, async ({
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
      const worker = plot.worker;
      if (worker === null) throw new Error("Missing render worker");
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
          worker.drawExact(frame, colors, mask, geometry.order, () =>
            geometry.colorOrder(colors.bins, colors.colorMapBins, colorMode),
          );
          while (worker.busy) await new Promise(requestAnimationFrame);
          const shown = capture(plot.workerCanvas);
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
          for (let i = 0; i < shown.length; i += 4) {
            ink += shown[i + 3];
            for (let channel = 0; channel < 4; channel++) {
              const alpha = channel === 3;
              const difference = Math.abs(
                shown[i + channel] * (alpha ? 1 : shown[i + 3] / 255) -
                  direct[i + channel] * (alpha ? 1 : direct[i + 3] / 255),
              );
              maximum = Math.max(maximum, difference);
              sum += difference;
            }
          }
          results.push({
            mode: `${colorMode}/${curved ? "curved" : "straight draft"}`,
            maximum,
            mean: sum / shown.length,
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

test("brush frames name the brush worker's selection instead of carrying it, and draw the same lines", async ({
  page,
}) => {
  await exposeShownPixels(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await loadParallelBenchmark(
    page,
    { rows: 4000, columns: 4, discrete: false, seed: 20261109 },
    "full",
  );
  await warmParallelWorker(page);
  const result = await page.evaluate(async () => {
    interface BrushedPlot {
      h: number;
      state: { dimensions: string[] };
      worker: Pick<RenderWorker, "busy" | "drawExact"> | null;
      workerCanvas: HTMLCanvasElement;
      liveBrushMask: { version: number | null } | null;
      redrawLines: () => void;
      startBrushGesture: (
        event: { sourceEvent: { target: Element }; y: number },
        dimension: string,
      ) => void;
      continueBrushGesture: (y: number) => void;
      endBrushGesture: () => void;
      pplot: { brush: (publish: boolean) => Promise<void> };
    }
    const win = window as unknown as ShownPixelsWindow & {
      __parallelProbe: { instance: { parallelPlot: () => BrushedPlot } };
    };
    const plot = win.__parallelProbe.instance.parallelPlot();
    const worker = plot.worker;
    if (worker === null) throw new Error("Missing render worker");
    const sent: { version: number | null; rows: boolean }[] = [];
    const draw = worker.drawExact.bind(worker);
    worker.drawExact = (frame, colors, selection, ...rest) => {
      sent.push(
        selection instanceof Uint8Array
          ? { version: null, rows: true }
          : { version: selection.version, rows: false },
      );
      draw(frame, colors, selection, ...rest);
    };
    const settled = async () => {
      do await new Promise(requestAnimationFrame);
      while (worker.busy);
      // The worker's canvas reaches the page a display frame after its reply.
      await new Promise(requestAnimationFrame);
    };
    const dimension = plot.state.dimensions[1];
    const overlay = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!overlay) throw new Error("Missing brush overlay");
    plot.startBrushGesture({ sourceEvent: { target: overlay }, y: plot.h * 0.2 }, dimension);
    plot.continueBrushGesture(plot.h * 0.6);
    await plot.pplot.brush(false);
    plot.endBrushGesture();
    await plot.pplot.brush(true);
    await settled();
    const named = win.shownPixels(plot.workerCanvas);
    const version = plot.liveBrushMask?.version ?? null;
    // The same selection, sent as the page's rows.
    const live = plot.liveBrushMask;
    if (live === null) throw new Error("No live brush selection");
    live.version = null;
    plot.redrawLines();
    await settled();
    const carried = win.shownPixels(plot.workerCanvas);
    let differing = 0;
    for (let i = 0; i < named.length; ++i) if (named[i] !== carried[i]) ++differing;
    return { version, sent, differing, length: named.length };
  });
  expect(result.version).not.toBeNull();
  const brushed = result.sent.slice(0, -1);
  expect(brushed.length).toBeGreaterThan(0);
  expect(brushed.every((frame) => frame.version !== null && !frame.rows)).toBe(true);
  expect(result.sent[result.sent.length - 1]).toEqual({ version: null, rows: true });
  expect(result.length).toBeGreaterThan(0);
  expect(result.differing).toBe(0);
});
