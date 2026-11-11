import {
  instrumentParallelBenchmark,
  loadParallelBenchmark,
  measureParallelBenchmark,
} from "../bench/parallel";
import { expect, test } from "./fixtures";

test("benchmark instrumentation leaves every rendered pixel unchanged", async ({ page }) => {
  const load = await loadParallelBenchmark(page, {
    rows: 300,
    columns: 10,
    discrete: false,
    seed: 20261109,
  });
  expect(load.firstFrameMs).toBeGreaterThan(0);
  const readPixels = () =>
    page.evaluateHandle(() => {
      interface Plot {
        redrawLines: () => void;
        foreground_ref: { current: HTMLCanvasElement };
      }
      const win = window as unknown as {
        __parallelProbe: { instance: { parallelPlot: () => Plot } };
      };
      const pp = win.__parallelProbe.instance.parallelPlot();
      pp.redrawLines();
      const canvas = pp.foreground_ref.current;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (!context) {
        throw new Error("No pixel readback context");
      }
      context.drawImage(canvas, 0, 0);
      return {
        width: copy.width,
        height: copy.height,
        pixels: context.getImageData(0, 0, copy.width, copy.height).data,
      };
    });
  const before = await readPixels();
  expect(await before.evaluate(({ pixels }) => pixels.some((channel) => channel !== 0))).toBe(true);
  await instrumentParallelBenchmark(page);
  const after = await readPixels();
  // Keep full-frame buffers in the browser: serializing millions of numbers can exceed the test deadline.
  const comparison = await page.evaluate(
    ({ before, after }) => {
      let changedBytes = 0;
      for (let index = 0; index < before.pixels.length; ++index) {
        if (before.pixels[index] !== after.pixels[index]) changedBytes++;
      }
      return {
        sameDimensions: before.width === after.width && before.height === after.height,
        sameLength: before.pixels.length === after.pixels.length,
        changedBytes,
      };
    },
    { before, after },
  );
  expect(comparison).toEqual({ sameDimensions: true, sameLength: true, changedBytes: 0 });
  await before.dispose();
  await after.dispose();
});

test("the benchmark measures real brush, axis and settled scroll draws", async ({ page }) => {
  await loadParallelBenchmark(page, {
    rows: 300,
    columns: 10,
    discrete: true,
    seed: 20261109,
  });
  const samples = await measureParallelBenchmark(page, 3);
  expect(samples.brush.filter((sample) => sample.stage === "filter")).toHaveLength(3);
  expect(samples.brush.filter((sample) => sample.stage === "brushCpu")).toHaveLength(3);
  expect(samples.axis.some((sample) => sample.stage === "fence")).toBe(true);
  expect(samples.scroll.filter((sample) => sample.stage === "scrollCpu")).toHaveLength(3);
  expect(samples.scroll.filter((sample) => sample.stage === "fence").length).toBeGreaterThanOrEqual(
    6,
  );
});

test("the continuous benchmark waits for worker images and completed GPU frames", async ({
  page,
}) => {
  const load = await loadParallelBenchmark(
    page,
    { rows: 300, columns: 10, discrete: false, seed: 20261109 },
    "low",
  );
  expect(load.renderMode).toBe("continuous");
  const loaded = await page.evaluate(() => {
    const win = window as unknown as {
      __parallelProbe: {
        instance: {
          parallelPlot: () => {
            continuousFrame: number;
            continuous: { busy: boolean };
            webgl: { busy: boolean };
          };
        };
      };
    };
    const pp = win.__parallelProbe.instance.parallelPlot();
    return { frames: pp.continuousFrame, workerBusy: pp.continuous.busy, gpuBusy: pp.webgl.busy };
  });
  expect(loaded.frames).toBeGreaterThan(0);
  expect(loaded.workerBusy).toBe(false);
  expect(loaded.gpuBusy).toBe(false);
  const samples = await measureParallelBenchmark(page, 2);
  for (const phase of [
    samples.full,
    samples.recompute,
    samples.brush,
    samples.axis,
    samples.scroll,
  ]) {
    for (const stage of [
      "worker",
      "histogram",
      "raster",
      "workerLatency",
      "completedFrame",
      "fence",
    ]) {
      expect(phase.some((sample) => sample.stage === stage)).toBe(true);
    }
  }
  expect(
    samples.recompute.filter((sample) => sample.stage === "fence").length,
  ).toBeGreaterThanOrEqual(2);
  expect(samples.brush.filter((sample) => sample.stage === "brushCpu")).toHaveLength(2);
});
