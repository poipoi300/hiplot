import { loadParallelBenchmark } from "../bench/parallel";
import type { HiPlot } from "../src/component";
import { expect, test } from "./fixtures";

interface ExecutionWindow {
  __parallelProbe: { instance: HiPlot };
  __workers?: number;
  __localDraws?: number;
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
  test(`${quality} lines render on a worker from the first frame`, async ({ page }) => {
    await page.addInitScript(() => {
      const OriginalWorker = Worker;
      const win = window as unknown as ExecutionWindow;
      win.__workers = 0;
      win.__localDraws = 0;
      // Lines are instanced draws; presenting a worker's image is a plain one.
      const draw = WebGL2RenderingContext.prototype.drawArraysInstanced;
      WebGL2RenderingContext.prototype.drawArraysInstanced = function (
        ...args: Parameters<typeof draw>
      ) {
        win.__localDraws = (win.__localDraws ?? 0) + 1;
        Reflect.apply(draw, this, args);
      };
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          win.__workers = (win.__workers ?? 0) + 1;
        }
      };
    });
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      quality,
    );
    await page.waitForFunction((quality) => {
      const plot = (window as unknown as ExecutionWindow).__parallelProbe.instance.parallelPlot();
      return (
        plot &&
        !plot.linesBusy &&
        !plot.continuous?.busy &&
        (quality === "full" ? plot.exact !== null : plot.continuous?.execution === "worker")
      );
    }, quality);
    const result = await page.evaluate(() => {
      const win = window as unknown as ExecutionWindow;
      return { localDraws: win.__localDraws, workers: win.__workers };
    });
    expect(result.localDraws).toBe(0);
    expect(result.workers).toBe(1);
  });
}

test("gestures draft exact lines while full frames are slow, ignoring frames from blocks", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 100, columns: 2, discrete: false, seed: 20261109 },
    "full",
  );
  const drafts = await page.evaluate(() => {
    interface DraftPlot {
      interacting: boolean;
      draftFrame: () => boolean;
      recordFrame: (finished: {
        milliseconds: number;
        fullQuality: boolean;
        fromBlocks: boolean;
      }) => void;
    }
    const plot = (
      window as unknown as ExecutionWindow
    ).__parallelProbe.instance.parallelPlot() as unknown as DraftPlot;
    // An axis drag: interacting without a brush gesture.
    plot.interacting = true;
    const full = (milliseconds: number) =>
      plot.recordFrame({ milliseconds, fullQuality: true, fromBlocks: false });
    const states = [plot.draftFrame()];
    full(200);
    full(200);
    states.push(plot.draftFrame());
    plot.recordFrame({ milliseconds: 1, fullQuality: true, fromBlocks: true });
    plot.recordFrame({ milliseconds: 1, fullQuality: false, fromBlocks: false });
    states.push(plot.draftFrame());
    full(1);
    states.push(plot.draftFrame());
    plot.interacting = false;
    return states;
  });
  expect(drafts).toEqual([false, true, true, false]);
});

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
