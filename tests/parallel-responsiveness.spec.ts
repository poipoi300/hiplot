import { loadParallelBenchmark } from "../bench/parallel";
import type { ExactRenderer } from "../src/parallel/exact_worker";
import type { FinishedFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

test("exact line work leaves browser frames available for the brush", async ({ page }) => {
  await loadParallelBenchmark(
    page,
    { rows: 50_000, columns: 10, discrete: false, seed: 20261109 },
    "full",
  );
  // Calibrate locally, then let the next draw use the measured session policy.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const plot = (
      window as unknown as {
        __parallelProbe: {
          instance: {
            parallelPlot: () => {
              redrawLines: () => void;
              linesBusy: boolean;
            };
          };
        };
      }
    ).__parallelProbe.instance.parallelPlot();
    for (let calibration = 0; calibration < 2; ++calibration) {
      plot.redrawLines();
      while (plot.linesBusy) await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  });
  await page.waitForFunction(() => {
    const plot = (
      window as unknown as {
        __parallelProbe: {
          instance: {
            parallelPlot: () => {
              exact: { busy: boolean } | null;
            };
          };
        };
      }
    ).__parallelProbe.instance.parallelPlot();
    return plot.exact !== null && !plot.exact.busy;
  });
  const result = await page.evaluate(async () => {
    const plot = (
      window as unknown as {
        __parallelProbe: {
          instance: {
            parallelPlot: () => {
              h: number;
              state: { dimensions: string[] };
              exact: Pick<ExactRenderer, "draw" | "busy"> & {
                onImage: (bitmap: ImageBitmap, finished: FinishedFrame) => void;
              };
              startBrushGesture: (
                event: { sourceEvent: { target: Element }; y: number },
                dimension: string,
              ) => void;
              continueBrushGesture: (y: number) => void;
              endBrushGesture: () => void;
            };
          };
        };
      }
    ).__parallelProbe.instance.parallelPlot();
    const dimension = plot.state.dimensions[1];
    const group = Array.from(document.querySelectorAll<SVGGElement>("g.dimension")).find(
      (node) => (node as SVGGElement & { __data__: string }).__data__ === dimension,
    );
    const target = group?.querySelector(".overlay");
    if (!group || !target) throw new Error("Missing brush axis");
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let submitted = 0;
    let completed = 0;
    const request = plot.exact.draw.bind(plot.exact);
    plot.exact.draw = (...args) => {
      if (args[0].drawnRows !== 50_000) throw new Error("Exact image must draw every row");
      submitted++;
      request(...args);
    };
    const publish = plot.exact.onImage.bind(plot.exact);
    plot.exact.onImage = (...args) => {
      completed++;
      publish(...args);
    };
    plot.startBrushGesture({ sourceEvent: { target }, y: plot.h * 0.1 }, dimension);
    const intervals: number[] = [];
    let previous = performance.now();
    let error = 0;
    for (let step = 0; step < 45; step++) {
      await frame();
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
      const fraction = 0.4 + step * 0.005;
      plot.continueBrushGesture(plot.h * fraction);
      const selection = group.querySelector(".selection");
      if (!selection) throw new Error("Missing live brush selection");
      const bottom = Number(selection.getAttribute("y")) + Number(selection.getAttribute("height"));
      error = Math.max(error, Math.abs(bottom / plot.h - fraction));
    }
    plot.endBrushGesture();
    while (plot.exact.busy) await frame();
    return { maximumInterval: Math.max(...intervals), error, submitted, completed };
  });
  await test.info().attach("brush-frame-timing", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(result.submitted).toBeGreaterThan(0);
  expect(result.completed).toBeGreaterThan(0);
  expect(result.error).toBeLessThan(1e-6);
  expect(result.maximumInterval).toBeLessThan(100);
});
