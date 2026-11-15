import { loadParallelBenchmark } from "../bench/parallel";
import type { BrushSelection, SelectionResult } from "../src/parallel/brush_selection";
import type { ContinuousRenderer } from "../src/parallel/continuous_renderer";
import type { RenderWorker } from "../src/parallel/render_worker";
import type { WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import { useDirectRenderer, warmParallelWorker } from "./plot";

interface InteractionPlot {
  h: number;
  state: { dimensions: string[] };
  webgl: WebGLLineRenderer;
  continuous: (Pick<ContinuousRenderer, "draw"> & { busy: boolean; refining: boolean }) | null;
  worker: Pick<RenderWorker, "busy" | "drawExact" | "drawContinuous"> | null;
  startBrushGesture: (event: { sourceEvent: { target: Element }; y: number }, axis: string) => void;
  continueBrushGesture: (y: number) => void;
  endBrushGesture: () => void;
  brushSelection: () => BrushSelection;
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
      // Selections arrive from the brush worker; lines are drawn once the newest one does.
      let selected: Promise<unknown> = Promise.resolve();
      const masks = pp.brushSelection();
      const select = masks.select.bind(masks);
      masks.select = (...args) => {
        selections++;
        const selection = select(...args);
        selected = selection;
        return selection;
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
      await selected;
      await frame();
      const caughtUp = { selections, rendered: [...rendered] };
      busy = true;
      pp.continueBrushGesture(pp.h * 0.85);
      await frame();
      const beforeRelease = selections;
      pp.endBrushGesture();
      await selected;
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
  const result = await page.evaluate(async () => {
    const pp = (
      window as unknown as {
        __parallelProbe: { instance: { parallelPlot: () => InteractionPlot } };
      }
    ).__parallelProbe.instance.parallelPlot();
    if (pp.continuous === null) throw new Error("Missing continuous renderer");
    const continuous = pp.continuous;
    let draws = 0;
    const draw = continuous.draw.bind(continuous);
    continuous.draw = (...args) => {
      draws++;
      draw(...args);
    };
    Object.defineProperty(pp.continuous, "busy", { configurable: true, get: () => true });
    Object.defineProperty(pp.continuous, "refining", { configurable: true, get: () => true });
    const dimension = pp.state.dimensions[1];
    const group = Array.from(document.querySelectorAll<SVGGElement>("g.dimension")).find(
      (node) => (node as SVGGElement & { __data__: string }).__data__ === dimension,
    );
    const target = group?.querySelector(".overlay");
    if (!target) throw new Error("Missing brush axis");
    let selections = 0;
    let selected: Promise<SelectionResult | null> = Promise.resolve(null);
    const masks = pp.brushSelection();
    const select = masks.select.bind(masks);
    masks.select = (...args) => {
      selections++;
      selected = select(...args);
      return selected;
    };
    pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
    pp.continueBrushGesture(pp.h * 0.6);
    // Requested within the move, while refinement is busy; drawn once the selection arrives.
    const requested = selections;
    const drawsBefore = draws;
    await selected;
    return { requested, drawn: draws - drawsBefore };
  });
  expect(result).toEqual({ requested: 1, drawn: 1 });
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
      // Each selection request, by the brush bottom it selects; the brush worker
      // answers them in order, and a request still waiting is replaced by a newer one.
      const requested: number[] = [];
      const delivered: number[] = [];
      let drawing: number | null = null;
      let newest: Promise<unknown> = Promise.resolve();
      const masks = pp.brushSelection();
      const select = masks.select.bind(masks);
      masks.select = (...args) => {
        const bottom = pp.brushSpans(dimension)[0].bottom / pp.h;
        requested.push(bottom);
        const selection = select(...args);
        // Runs before the plot draws the result, which it chains after this returns.
        void selection.then((result) => {
          if (result === null) return;
          delivered.push(bottom);
          drawing = bottom;
        });
        newest = selection;
        return selection;
      };
      const posted: (number | null)[] = [];
      const drawExact = worker.drawExact.bind(worker);
      worker.drawExact = (...args) => {
        posted.push(drawing);
        drawExact(...args);
      };
      const drawContinuous = worker.drawContinuous.bind(worker);
      worker.drawContinuous = (...args) => {
        posted.push(drawing);
        drawContinuous(...args);
      };
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
      const selections: number[] = [];
      for (const fractions of [
        [0.45, 0.5],
        [0.6, 0.65, 0.7],
      ]) {
        for (const fraction of fractions) pp.continueBrushGesture(pp.h * fraction);
        selections.push(requested.length);
        await frame();
      }
      selections.push(requested.length);
      await newest;
      const observed = {
        selections,
        requested: [...requested],
        delivered: [...delivered],
        posted: [...posted],
      };
      pp.endBrushGesture();
      return observed;
    });
    // The first move selects at once; each display frame then selects the latest
    // move before it, and none waits for the busy worker: every selection the
    // brush worker returns posts its frame at once.
    expect(result.selections).toEqual([1, 2, 3]);
    expect(result.requested).toHaveLength(3);
    for (const [index, fraction] of [0.45, 0.5, 0.7].entries())
      expect(result.requested[index]).toBeCloseTo(fraction, 6);
    // The first request is sent at once and the last is the newest: both arrive.
    // The middle one is replaced only if it was still waiting for the first.
    expect(result.delivered[0]).toBe(result.requested[0]);
    expect(result.delivered[result.delivered.length - 1]).toBe(result.requested[2]);
    expect(result.posted).toEqual(result.delivered);
  });
}
