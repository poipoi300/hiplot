import { loadParallelBenchmark } from "../bench/parallel";
import type { RenderWorker } from "../src/parallel/render_worker";
import type { BrushMasks } from "../src/parallel/selection";
import type { WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import { useDirectRenderer, warmParallelWorker } from "./plot";

interface InteractionPlot {
  h: number;
  state: { dimensions: string[] };
  webgl: WebGLLineRenderer;
  continuous: { busy: boolean; refining: boolean } | null;
  worker: Pick<RenderWorker, "busy" | "drawExact" | "drawContinuous"> | null;
  startBrushGesture: (event: { sourceEvent: { target: Element }; y: number }, axis: string) => void;
  continueBrushGesture: (y: number) => void;
  endBrushGesture: () => void;
  brushMasks: () => BrushMasks;
  drawWithWebGL: (renderer: WebGLLineRenderer) => void;
  drawContinuous: () => void;
  brushSpans: (dimension: string) => { top: number; bottom: number }[];
}

for (const [quality, renderer] of [
  ["full", "webgl"],
  ["low", "webgl"],
  ["low", "continuous"],
] as const) {
  test(`${quality} brush feedback follows every frame while ${renderer} is busy`, async ({
    page,
  }) => {
    // Brush moves wait only for lines the page draws: the render worker never holds them back.
    await useDirectRenderer(page);
    await loadParallelBenchmark(
      page,
      { rows: 50_000, columns: 4, discrete: false, seed: 20261109 },
      quality,
    );
    await page.evaluate(() => {
      (
        window as unknown as {
          __parallelProbe: {
            instance: {
              parallelPlot: () => {
                redrawLines: () => void;
              };
            };
          };
        }
      ).__parallelProbe.instance
        .parallelPlot()
        .redrawLines();
    });
    await page.waitForFunction(() => {
      const plot = (
        window as unknown as {
          __parallelProbe: {
            instance: {
              parallelPlot: () => {
                linesBusy: boolean;
                continuous: { busy: boolean } | null;
              };
            };
          };
        }
      ).__parallelProbe.instance.parallelPlot();
      return !plot.linesBusy && !plot.continuous?.busy;
    });
    const result = await page.evaluate(async (renderer) => {
      const pp = (
        window as unknown as {
          __parallelProbe: { instance: { parallelPlot: () => InteractionPlot } };
        }
      ).__parallelProbe.instance.parallelPlot();
      const dimension = pp.state.dimensions[1];
      const group = Array.from(document.querySelectorAll<SVGGElement>("g.dimension")).find(
        (node) => (node as SVGGElement & { __data__: string }).__data__ === dimension,
      );
      const target = group?.querySelector(".overlay");
      if (!group || !target) throw new Error("Missing brush axis");
      let busy = true;
      const active = pp[renderer];
      if (active === null) throw new Error(`Missing ${renderer} renderer`);
      Object.defineProperty(active, "busy", { configurable: true, get: () => busy });
      let selections = 0;
      const masks = pp.brushMasks();
      const select = masks.select.bind(masks);
      masks.select = (...args) => {
        selections++;
        return select(...args);
      };
      const rendered: number[] = [];
      const drawExact = pp.drawWithWebGL.bind(pp);
      pp.drawWithWebGL = (renderer) => {
        rendered.push(pp.brushSpans(dimension)[0].bottom / pp.h);
        drawExact(renderer);
      };
      const drawContinuous = pp.drawContinuous.bind(pp);
      pp.drawContinuous = () => {
        rendered.push(pp.brushSpans(dimension)[0].bottom / pp.h);
        drawContinuous();
      };
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
      const overlays: { bottom: number; handle: number }[] = [];
      for (const fraction of [0.45, 0.6, 0.75]) {
        pp.continueBrushGesture(pp.h * fraction);
        await frame();
        const selection = group.querySelector(".selection");
        const handle = group.querySelector(".handle[data-edge='bottom']");
        if (!selection || !handle) throw new Error("Missing live brush feedback");
        overlays.push({
          bottom:
            (Number(selection.getAttribute("y")) + Number(selection.getAttribute("height"))) / pp.h,
          handle:
            (Number(handle.getAttribute("y")) + Number(handle.getAttribute("height")) / 2) / pp.h,
        });
      }
      const inFlight = { selections, renders: rendered.length };
      busy = false;
      await frame();
      await frame();
      const caughtUp = { selections, rendered: [...rendered] };
      busy = true;
      pp.continueBrushGesture(pp.h * 0.85);
      await frame();
      const beforeRelease = selections;
      pp.endBrushGesture();
      return { overlays, inFlight, caughtUp, beforeRelease, released: { selections, rendered } };
    }, renderer);
    expect(result.overlays).toHaveLength(3);
    for (const [index, fraction] of [0.45, 0.6, 0.75].entries()) {
      expect(result.overlays[index].bottom).toBeCloseTo(fraction, 6);
      expect(result.overlays[index].handle).toBeCloseTo(fraction, 6);
    }
    expect(result.inFlight).toEqual({ selections: 0, renders: 0 });
    expect(result.caughtUp.selections).toBe(1);
    expect(result.caughtUp.rendered).toHaveLength(1);
    expect(result.caughtUp.rendered[0]).toBeCloseTo(0.75, 6);
    expect(result.beforeRelease).toBe(1);
    expect(result.released.selections).toBe(2);
    expect(result.released.rendered).toHaveLength(2);
    expect(result.released.rendered[1]).toBeCloseTo(0.85, 6);
  });
}

test("a brush dispatches immediately while continuous release refinement is busy", async ({
  page,
}) => {
  await useDirectRenderer(page);
  await loadParallelBenchmark(
    page,
    { rows: 50_000, columns: 4, discrete: false, seed: 20261109 },
    "low",
  );
  const selections = await page.evaluate(() => {
    const pp = (
      window as unknown as {
        __parallelProbe: { instance: { parallelPlot: () => InteractionPlot } };
      }
    ).__parallelProbe.instance.parallelPlot();
    if (pp.continuous === null) throw new Error("Missing continuous renderer");
    Object.defineProperty(pp.continuous, "busy", { configurable: true, get: () => true });
    Object.defineProperty(pp.continuous, "refining", { configurable: true, get: () => true });
    const dimension = pp.state.dimensions[1];
    const group = Array.from(document.querySelectorAll<SVGGElement>("g.dimension")).find(
      (node) => (node as SVGGElement & { __data__: string }).__data__ === dimension,
    );
    const target = group?.querySelector(".overlay");
    if (!target) throw new Error("Missing brush axis");
    let selections = 0;
    const masks = pp.brushMasks();
    const select = masks.select.bind(masks);
    masks.select = (...args) => {
      selections++;
      return select(...args);
    };
    pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
    pp.continueBrushGesture(pp.h * 0.6);
    return selections;
  });
  expect(selections).toBe(1);
});

for (const quality of ["full", "low"] as const) {
  test(`${quality} brush moves on a busy render worker select once per display frame`, async ({
    page,
  }) => {
    await loadParallelBenchmark(
      page,
      { rows: 50_000, columns: 4, discrete: false, seed: 20261109 },
      quality,
    );
    await warmParallelWorker(page);
    const result = await page.evaluate(async () => {
      const pp = (
        window as unknown as {
          __parallelProbe: { instance: { parallelPlot: () => InteractionPlot } };
        }
      ).__parallelProbe.instance.parallelPlot();
      const worker = pp.worker;
      if (worker === null) throw new Error("Missing render worker");
      Object.defineProperty(worker, "busy", { configurable: true, get: () => true });
      const dimension = pp.state.dimensions[1];
      const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
        .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
        ?.querySelector(".overlay");
      if (!target) throw new Error("Missing brush axis");
      let selections = 0;
      const masks = pp.brushMasks();
      const select = masks.select.bind(masks);
      masks.select = (...args) => {
        selections++;
        return select(...args);
      };
      const posted: number[] = [];
      const record = (): void => {
        posted.push(pp.brushSpans(dimension)[0].bottom / pp.h);
      };
      const drawExact = worker.drawExact.bind(worker);
      worker.drawExact = (...args) => {
        record();
        drawExact(...args);
      };
      const drawContinuous = worker.drawContinuous.bind(worker);
      worker.drawContinuous = (...args) => {
        record();
        drawContinuous(...args);
      };
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
      const steps: { selections: number; posted: number[] }[] = [];
      for (const fractions of [
        [0.45, 0.5],
        [0.6, 0.65, 0.7],
      ]) {
        for (const fraction of fractions) pp.continueBrushGesture(pp.h * fraction);
        steps.push({ selections, posted: [...posted] });
        await frame();
      }
      steps.push({ selections, posted: [...posted] });
      pp.endBrushGesture();
      return steps;
    });
    // The first move selects at once; each display frame then selects the latest
    // move before it, and none waits for the busy worker.
    expect(result.map((step) => step.selections)).toEqual([1, 2, 3]);
    const expected = [[0.45], [0.45, 0.5], [0.45, 0.5, 0.7]];
    for (const [index, step] of result.entries()) {
      expect(step.posted).toHaveLength(expected[index].length);
      for (const [draw, fraction] of expected[index].entries())
        expect(step.posted[draw]).toBeCloseTo(fraction, 6);
    }
  });
}
