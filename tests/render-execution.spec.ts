import { loadParallelBenchmark } from "../bench/parallel";
import type { HiPlot } from "../src/component";
import { expect, test } from "./fixtures";

interface ExecutionWindow {
  __parallelProbe: { instance: HiPlot };
  __workers?: number;
  __localDraws?: number;
  __firstWorkerLocalDraws?: number;
}

test("switching to density after moving a brush keeps the latest exact image until density is ready", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 100, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  const result = await page.evaluate(async () => {
    const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
    if (!plot) throw new Error("Missing plot");
    const idle = async () => {
      while (plot.linesBusy || plot.continuous?.busy) await new Promise(requestAnimationFrame);
    };
    const switchMode = (renderQuality: "full" | "low") =>
      new Promise<void>((resolve) => plot.setState({ renderQuality }, resolve));
    const visibility = () => ({
      exact: plot.exact_image_ref.current?.style.visibility,
      direct: plot.foreground_ref.current?.style.visibility,
    });
    plot.renderExecution.record(51);
    plot.renderExecution.record(51);
    const dimension = plot.state.dimensions[1];
    plot.setBrushes(dimension, [[plot.h * 0.1, plot.h * 0.3]]);
    await idle();
    const switches = [];
    for (const [top, bottom] of [
      [0.6, 0.8],
      [0.2, 0.4],
    ]) {
      await switchMode("full");
      await idle();
      plot.setBrushes(dimension, [[plot.h * top, plot.h * bottom]]);
      await idle();
      const before = visibility();
      const frames = plot.continuousFrame;
      await switchMode("low");
      const pending = visibility();
      const pendingFrames = plot.continuousFrame - frames;
      await idle();
      switches.push({ before, pending, pendingFrames, after: visibility() });
    }
    return switches;
  });
  for (const transition of result) {
    expect(transition.before).toEqual({ exact: "visible", direct: "hidden" });
    expect(transition.pendingFrames).toBe(0);
    expect(transition.pending).toEqual(transition.before);
    expect(transition.after).toEqual({ exact: "hidden", direct: "visible" });
  }
});

for (const quality of ["full", "low"] as const) {
  test(`${quality} starts locally and shares worker promotion across rendering modes`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const OriginalWorker = Worker;
      const win = window as unknown as ExecutionWindow;
      win.__workers = 0;
      win.__localDraws = 0;
      for (const method of ["drawArrays", "drawArraysInstanced"] as const) {
        const draw = WebGL2RenderingContext.prototype[method];
        WebGL2RenderingContext.prototype[method] = function (...args: number[]) {
          win.__localDraws = (win.__localDraws ?? 0) + 1;
          Reflect.apply(draw, this, args);
        };
      }
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          win.__workers = (win.__workers ?? 0) + 1;
          win.__firstWorkerLocalDraws ??= win.__localDraws;
        }
      };
    });
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      quality,
    );
    const initial = await page.evaluate(() => {
      const win = window as unknown as ExecutionWindow;
      return {
        localDraws: win.__localDraws ?? 0,
        beforeWorker: win.__firstWorkerLocalDraws ?? win.__localDraws ?? 0,
      };
    });
    expect(initial.localDraws).toBeGreaterThan(0);
    expect(initial.beforeWorker).toBeGreaterThan(0);
    // Supply a completed slow-frame measurement without depending on the test machine's GPU speed.
    await page.evaluate(() => {
      const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
      if (!plot) throw new Error("Missing plot");
      plot.renderExecution.record(51);
      plot.renderExecution.record(51);
      plot.redrawLines();
    });
    await page.waitForFunction((quality) => {
      const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
      return (
        plot &&
        !plot.linesBusy &&
        !plot.continuous?.busy &&
        (quality === "full" ? plot.exact !== null : plot.continuous?.execution === "worker")
      );
    }, quality);
    await page.evaluate((quality) => {
      const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
      if (!plot) throw new Error("Missing plot");
      plot.renderExecution.record(1);
      plot.setState({ renderQuality: quality === "full" ? "low" : "full" });
    }, quality);
    await page.waitForFunction((quality) => {
      const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
      return (
        plot?.renderExecution.useWorker &&
        !plot.linesBusy &&
        !plot.continuous?.busy &&
        (quality === "full" ? plot.continuous?.execution === "worker" : plot.exact !== null)
      );
    }, quality);
    expect(await page.evaluate(() => (window as unknown as ExecutionWindow).__workers)).toBe(2);
  });
}

test("legacy automatic line shape migrates to curved at phone width", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(
      '/?provider=upload&hip.PARALLEL_PLOT.lineShape="auto"&hip.PARALLEL_PLOT.renderQuality="low"',
    );
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(390);
    await page.locator("input[type=file]").setInputFiles({
      name: "rows.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("a,b\n1,2\n2,3\n3,1"),
    });
    await page.waitForFunction(() => {
      const plot = (
        window as unknown as { hiplot_last_instance: HiPlot }
      ).hiplot_last_instance.parallelPlot();
      return (
        plot !== null &&
        plot.continuousMetrics !== null &&
        plot.continuousFrame > 0 &&
        !plot.continuous?.busy
      );
    });
    const result = await page.evaluate(() => {
      const plot = (
        window as unknown as { hiplot_last_instance: HiPlot }
      ).hiplot_last_instance.parallelPlot();
      if (!plot?.continuousMetrics) throw new Error("Missing density image");
      return {
        shape: plot.state.lineShape,
        curved: plot.curvedLines(),
        width: plot.continuousMetrics.width,
        height: plot.continuousMetrics.height,
        physicalWidth: Math.ceil(plot.w * devicePixelRatio),
        physicalHeight: Math.ceil(plot.h * devicePixelRatio),
      };
    });
    expect(result.shape).toBe("curved");
    expect(result.curved).toBe(true);
    expect(result.width).toBe(result.physicalWidth);
    expect(result.height).toBe(result.physicalHeight);
    await expect(
      page
        .getByRole("group", { name: "Line shape" })
        .getByRole("button", { name: "Auto", exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
