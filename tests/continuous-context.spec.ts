import { loadParallelBenchmark } from "../bench/parallel";
import { expect, test } from "./fixtures";

interface ContextWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousFrame: number;
        continuous: { busy: boolean };
        continuousMetrics: { pixels: Uint8ClampedArray; rows: number };
      };
    };
  };
}

test("lost worker WebGL preserves histograms and subsequent images via CPU", async ({ page }) => {
  await loadParallelBenchmark(
    page,
    { rows: 300, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  const worker = page.workers()[0];
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
        return plot.continuousFrame > before && !plot.continuous.busy;
      }, before),
      page.waitForEvent("pageerror").then((error) => {
        throw error;
      }),
    ]);
    const image = await page.evaluate(() => {
      const image = (window as unknown as ContextWindow).__parallelProbe.instance.parallelPlot()
        .continuousMetrics;
      return {
        rows: image.rows,
        nonblank: image.pixels.some((value, index) => index % 4 === 3 && value > 0),
      };
    });
    expect(image).toEqual({ rows: 300, nonblank: true });
    expect(page.workers()).toHaveLength(1);
  }
});
