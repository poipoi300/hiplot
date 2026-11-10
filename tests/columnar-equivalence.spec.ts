import type { Page } from "@playwright/test";
import { loadParallelBenchmark } from "../bench/parallel";
import type { Filter } from "../src/filters";
import type { LineGeometry } from "../src/parallel/geometry";
import type { BrushMasks } from "../src/parallel/selection";
import type { Datapoint } from "../src/types";
import { expect, test } from "./fixtures";

interface PlotProbe {
  state: { dimensions: string[] };
  props: { rows_selected: Datapoint[]; rows_filtered: Datapoint[] };
  h: number;
  webgl: object | null;
  interacting: boolean;
  foreground_ref: { current: HTMLCanvasElement };
  geometry: () => LineGeometry;
  brushMasks: () => BrushMasks;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  redrawLines: () => void;
  drawWithWebGL: (webgl: object) => void;
  startBrushGesture: (
    event: { sourceEvent: { target: Element }; y: number },
    dimension: string,
  ) => void;
  continueBrushGesture: (y: number) => void;
  endBrushGesture: () => void;
  cancelBrushMove: () => void;
  pplot: { brush: (publish: boolean) => void };
  setState: (state: { dimensions: string[] }, callback: () => void) => void;
  setBrushes: (dimension: string, spans: readonly (readonly [number, number])[]) => void;
  hasBrushes: (dimension: string) => boolean;
  yscale: Record<string, object>;
  createScale: (dimension: string) => object | null;
}
interface RootProbe {
  parallelPlot: () => PlotProbe;
  setSelected: (rows: Datapoint[], filter: Filter) => void;
  filterRows: (keep: boolean) => void;
  restoreAllRows: () => void;
}
interface ProbeWindow {
  __parallelProbe: { instance: RootProbe };
  hiplot_last_instance: RootProbe;
}

async function load(page: Page): Promise<void> {
  await loadParallelBenchmark(page, { rows: 300, columns: 10, discrete: false, seed: 20261109 });
}

async function pixels(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    pp.redrawLines();
    const canvas = pp.foreground_ref.current;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) {
      throw new Error("No readback context");
    }
    context.drawImage(canvas, 0, 0);
    return Array.from(context.getImageData(0, 0, copy.width, copy.height).data);
  });
}

test("live WebGL brushes use typed flags and publish identical pixels and ordered rows", async ({
  page,
}) => {
  await load(page);
  const result = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const masks = pp.brushMasks();
    const selectedRows = masks.selectedRows.bind(masks);
    let materializations = 0;
    masks.selectedRows = (mask) => {
      materializations += 1;
      return selectedRows(mask);
    };
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) {
      throw new Error("No brush overlay");
    }
    const initialRows = pp.props.rows_selected;
    pp.startBrushGesture({ sourceEvent: { target }, y: 0.2 * pp.h }, dimension);
    pp.continueBrushGesture(0.6 * pp.h);
    pp.cancelBrushMove();
    pp.pplot.brush(false);
    const duringCalls = materializations;
    const unchangedPublishedRows = pp.props.rows_selected === initialRows;
    const mask = pp.selectionMask(pp.geometry());
    const expected = pp.props.rows_filtered
      .filter((_, row) => mask[row] === 1)
      .map((row) => row.uid);
    const read = (): Uint8ClampedArray => {
      if (pp.webgl === null) {
        throw new Error("Expected a WebGL renderer");
      }
      // Compare submitted frames, not the gesture scheduler's deferred previous frame.
      pp.drawWithWebGL(pp.webgl);
      const canvas = pp.foreground_ref.current;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) {
        throw new Error("No readback context");
      }
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const before = read();
    pp.endBrushGesture();
    // Rebuild selection flags from published objects, the pre-columnar reference path.
    (pp as unknown as { liveBrushMask: unknown }).liveBrushMask = null;
    const after = read();
    const published = (pp as unknown as { publishedSelection: Datapoint[] }).publishedSelection.map(
      (row) => row.uid,
    );
    let differingChannels = 0;
    for (let channel = 0; channel < before.length; ++channel) {
      differingChannels += Number(before[channel] !== after[channel]);
    }
    return {
      duringCalls,
      afterCalls: materializations,
      unchangedPublishedRows,
      differingChannels,
      expected,
      published,
    };
  });
  expect(result.duringCalls).toBe(0);
  expect(result.afterCalls).toBe(1);
  expect(result.unchangedPublishedRows).toBe(true);
  expect(result.expected.length).toBeGreaterThan(0);
  expect(result.expected.length).toBeLessThan(300);
  expect(result.published).toEqual(result.expected);
  expect(result.differingChannels).toBe(0);
});

test("successive live brush moves refresh exact GPU flags even when the mask buffer is reused", async ({
  page,
}) => {
  await load(page);
  const result = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target || pp.webgl === null) throw new Error("No exact brush renderer");
    const read = (): Uint8ClampedArray => {
      pp.drawWithWebGL(pp.webgl as object);
      const canvas = pp.foreground_ref.current;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) throw new Error("No readback context");
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    pp.startBrushGesture({ sourceEvent: { target }, y: 0.2 * pp.h }, dimension);
    pp.continueBrushGesture(0.4 * pp.h);
    pp.cancelBrushMove();
    pp.pplot.brush(false);
    read();
    const first = pp.selectionMask(pp.geometry()).slice();
    pp.continueBrushGesture(0.8 * pp.h);
    pp.cancelBrushMove();
    pp.pplot.brush(false);
    const mask = pp.selectionMask(pp.geometry());
    const actual = read();
    (pp.webgl as { setSelection: (mask: Uint8Array) => void }).setSelection(mask.slice());
    const reference = read();
    let differing = 0;
    for (let channel = 0; channel < actual.length; ++channel)
      differing += Number(actual[channel] !== reference[channel]);
    pp.endBrushGesture();
    return {
      differing,
      changed: first.reduce((sum, value, row) => sum + Number(value !== mask[row]), 0),
    };
  });
  expect(result.changed).toBeGreaterThan(20);
  expect(result.differing).toBe(0);
});

test("order-only reorders retain scale and pixel identities with unchanged output", async ({
  page,
}) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const order = [...pp.state.dimensions];
    const geometry = pp.geometry();
    const scales = new Map(order.map((dimension) => [dimension, pp.yscale[dimension]]));
    const columns = new Map(
      order.map((dimension) => [
        dimension,
        geometry.pixels(
          dimension,
          pp.yscale[dimension] as Parameters<LineGeometry["pixels"]>[1],
          true,
        ),
      ]),
    );
    const reordered = [...order];
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    await new Promise<void>((resolve) => pp.setState({ dimensions: reordered }, resolve));
    const retainedScales = order.every(
      (dimension) => scales.get(dimension) === pp.yscale[dimension],
    );
    const retainedColumns = order.every(
      (dimension) =>
        columns.get(dimension) ===
        geometry.pixels(
          dimension,
          pp.yscale[dimension] as Parameters<LineGeometry["pixels"]>[1],
          true,
        ),
    );
    return { retainedScales, retainedColumns };
  });
  expect(result).toEqual({ retainedScales: true, retainedColumns: true });
  const retained = await pixels(page);
  // A freshly recomputed reference must render exactly the same reordered picture.
  await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    for (const dimension of pp.state.dimensions) {
      const scale = pp.createScale(dimension);
      if (scale === null) {
        throw new Error(`Missing reference scale ${dimension}`);
      }
      pp.yscale[dimension] = scale;
    }
  });
  expect(await pixels(page)).toEqual(retained);
});

test("external lasso, Keep and Restore replace row-identified brush flags", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    pp.setBrushes(pp.state.dimensions[1], [[pp.h * 0.2, pp.h * 0.6]]);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
        return pp.props.rows_selected.length;
      }),
    )
    .toBeLessThan(300);
  const expected = await page.evaluate(async () => {
    const root = (window as unknown as ProbeWindow).__parallelProbe.instance;
    const pp = root.parallelPlot();
    const selected = pp.props.rows_filtered.slice(0, 3);
    const uids = selected.map((row) => row.uid);
    root.setSelected(selected, { type: "Lasso", data: uids } as Filter);
    return uids;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
        const geometry = pp.geometry();
        const mask = pp.selectionMask(geometry);
        return geometry.rows.filter((_, row) => mask[row] === 1).map((row) => row.uid);
      }),
    )
    .toEqual(expected);
  expect(
    await page.evaluate(() => {
      const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      return pp.state.dimensions.some((dimension) => pp.hasBrushes(dimension));
    }),
  ).toBe(false);
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).__parallelProbe.instance.filterRows(true),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
        return {
          rows: pp.geometry().rows.length,
          mask: Array.from(pp.selectionMask(pp.geometry())),
        };
      }),
    )
    .toEqual({ rows: 3, mask: [1, 1, 1] });
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).__parallelProbe.instance.restoreAllRows(),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
        return {
          rows: pp.geometry().rows.length,
          count: pp.selectionMask(pp.geometry()).reduce((sum, flag) => sum + flag, 0),
        };
      }),
    )
    .toEqual({ rows: 300, count: 300 });
});

test("Canvas fallback still materializes every live brush selection", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      options?: unknown,
    ) {
      return kind === "webgl2" ? null : getContext.call(this, kind, options);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/?provider=upload");
  await page.locator("input[type=file]").setInputFiles({
    name: "columnar.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      ["a,b,c", ...Array.from({ length: 300 }, (_, row) => `${row},${row % 97},${row % 83}`)].join(
        "\n",
      ),
    ),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached" });
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.hiplot_last_instance.parallelPlot();
    const masks = pp.brushMasks();
    const selectRows = masks.selectedRows.bind(masks);
    let calls = 0;
    masks.selectedRows = (mask) => {
      calls += 1;
      return selectRows(mask);
    };
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) {
      throw new Error("No fallback brush overlay");
    }
    pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
    pp.continueBrushGesture(pp.h * 0.6);
    pp.cancelBrushMove();
    pp.pplot.brush(false);
    const mask = pp.selectionMask(pp.geometry());
    const expected = pp.props.rows_filtered
      .filter((_, row) => mask[row] === 1)
      .map((row) => row.uid);
    const drawn = (pp as unknown as { drawnSelection: Datapoint[] }).drawnSelection.map(
      (row) => row.uid,
    );
    const during = calls;
    pp.endBrushGesture();
    return { webgl: pp.webgl, during, after: calls, expected, drawn };
  });
  expect(result.webgl).toBeNull();
  expect(result.during).toBe(1);
  expect(result.after).toBe(2);
  expect(result.expected.length).toBeGreaterThan(0);
  expect(result.drawn).toEqual(result.expected);
});

test("capped spare pixel slots produce the same picture as unrestricted texture growth", async ({
  page,
  context,
}) => {
  await load(page);
  const unrestricted = await pixels(page);
  const capped = await context.newPage();
  await capped.addInitScript(() => {
    const getParameter = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
      return parameter === this.MAX_TEXTURE_SIZE ? 64 : getParameter.call(this, parameter);
    };
  });
  await load(capped);
  expect(await pixels(capped)).toEqual(unrestricted);
  await capped.close();
});
