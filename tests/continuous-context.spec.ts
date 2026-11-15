import { loadParallelBenchmark } from "../bench/parallel";
import { expect, test } from "./fixtures";
import {
  exposeShownPixels,
  renderWorker,
  renderWorkers,
  type ShownPixelsWindow,
  warmParallelWorker,
} from "./plot";

interface ContextWindow extends ShownPixelsWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousFrame: number;
        linesBusy: boolean;
        continuousMetrics: { rows: number };
        workerCanvas: HTMLCanvasElement;
      };
    };
  };
}

test("lost worker WebGL preserves histograms and subsequent images via CPU", async ({ page }) => {
  await exposeShownPixels(page);
  await loadParallelBenchmark(
    page,
    { rows: 300, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  await warmParallelWorker(page);
  const worker = await renderWorker(page);
  expect(worker).toBeDefined();
  await worker.evaluate(() => {
    const original = WebGL2RenderingContext.prototype.isContextLost;
    WebGL2RenderingContext.prototype.isContextLost = function () {
      WebGL2RenderingContext.prototype.isContextLost = original;
      const extension = this.getExtension("WEBGL_lose_context");
      if (extension === null) throw new Error("Missing actual context-loss extension");
      extension.loseContext();
      return original.call(this);
    };
  });
  for (const shape of ["Straight", "Curved"]) {
    const before = await page.evaluate(
      () =>
        (window as unknown as ContextWindow).__parallelProbe.instance.parallelPlot()
          .continuousFrame,
    );
    await page
      .getByRole("group", { name: "Line shape" })
      .getByRole("button", { name: shape, exact: true })
      .click();
    await Promise.race([
      page.waitForFunction((before) => {
        const plot = (window as unknown as ContextWindow).__parallelProbe.instance.parallelPlot();
        return plot.continuousFrame > before && !plot.linesBusy;
      }, before),
      page.waitForEvent("pageerror").then((error) => {
        throw error;
      }),
    ]);
    const image = await page.evaluate(() => {
      const win = window as unknown as ContextWindow;
      const plot = win.__parallelProbe.instance.parallelPlot();
      // The worker shows its images on its canvas.
      const pixels = win.shownPixels(plot.workerCanvas);
      return {
        rows: plot.continuousMetrics.rows,
        nonblank: pixels.some((value, index) => index % 4 === 3 && value > 0),
      };
    });
    expect(image).toEqual({ rows: 300, nonblank: true });
    expect(await renderWorkers(page)).toHaveLength(1);
  }
});
