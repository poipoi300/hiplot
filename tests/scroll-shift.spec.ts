import type { Page } from "@playwright/test";
import { loadParallelBenchmark } from "../bench/parallel";
import type { LineGeometry } from "../src/parallel/geometry";
import type { LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface Shifted {
  offset: number;
  /** Shifted versus full frame: the largest channel difference and how many channels differ. */
  maximum: number;
  differing: number;
  channels: number;
  /** In the columns the move exposed: differing channels, and ink. */
  stripDiffering: number;
  stripInk: number;
  drewEveryRow: boolean;
  instances: number;
  fullInstances: number;
  /** Line draw calls of the moved frame: its batches. */
  calls: number;
}

/**
 * Draws a frame with the page's renderer, moves its axes by each offset in a
 * frame marked `transient` (a scroll's, unless false), and compares it with a
 * settled full frame of the same axes. `change` alters the selection or the
 * colors between the first frame and the moved one; `cooperative` draws the
 * moved frame in small cooperative batches, as the exact worker does.
 */
async function measureShifts(
  page: Page,
  options: {
    rows: number;
    curved: boolean;
    axes: number[];
    offsets: number[];
    missing: boolean;
    transient?: false;
    change?: "selection" | "colors";
    cooperative?: true;
  },
): Promise<Shifted[]> {
  await loadParallelBenchmark(
    page,
    { rows: options.rows, columns: options.axes.length, discrete: false, seed: 20261109 },
    "full",
  );
  return page.evaluate(
    async ({ curved, axes, offsets, missing, transient, change, cooperative }) => {
      interface PagePlot {
        webgl: Pick<
          WebGLLineRenderer,
          | "setRows"
          | "setDrawOrder"
          | "setColors"
          | "setSelection"
          | "draw"
          | "drawCooperative"
          | "busy"
        >;
        geometry: () => LineGeometry;
        lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
        lineColors: (geometry: LineGeometry) => Parameters<WebGLLineRenderer["setColors"]>[0];
      }
      const plot = (
        window as unknown as { __parallelProbe: { instance: { parallelPlot: () => PagePlot } } }
      ).__parallelProbe.instance.parallelPlot();
      const { webgl } = plot;
      const internals = webgl as unknown as {
        gl: WebGL2RenderingContext;
        inFlightDrewEveryRow: boolean;
        lineBatches: { rows: number };
        stripBatches: { rows: number } | null;
      };
      const gl = internals.gl;
      let instances = 0;
      let calls = 0;
      const drawInstanced = gl.drawArraysInstanced.bind(gl);
      gl.drawArraysInstanced = (mode, first, count, instanceCount) => {
        instances += instanceCount;
        calls += 1;
        drawInstanced(mode, first, count, instanceCount);
      };
      const geometry = plot.geometry();
      const mask = Uint8Array.from(geometry.order, (_, row) => Number(row % 3 !== 0));
      const plotted = plot.lineFrame(geometry, mask);
      const source: LineFrame = {
        ...plotted,
        curved,
        draft: false,
        axes: plotted.axes.map((axis, index) => ({
          x: axes[index],
          // Missing values draw stubs from the axes either side of them.
          pixels: Float32Array.from(axis.pixels, (y, row) =>
            missing && index % 2 === 1 && row % 11 === 0 ? Number.NaN : y,
          ),
        })),
      };
      webgl.setRows(geometry.rows.length, geometry.order);
      webgl.setDrawOrder(geometry.order);
      const colors = plot.lineColors(geometry);
      const changedMask = Uint8Array.from(mask, (selected) => 1 - selected);
      const changedColors = { ...colors, bins: Uint32Array.from(colors.bins).reverse() };
      const moved = (offset: number): LineFrame => ({
        ...source,
        axes: source.axes.map((axis) => ({ ...axis, x: axis.x + offset })),
      });
      // The default framebuffer is read in the task that drew it, before it is presented.
      const draw = async (frame: LineFrame, batched = false) => {
        while (webgl.busy) await new Promise(requestAnimationFrame);
        instances = 0;
        calls = 0;
        let drewEveryRow: boolean;
        if (batched) {
          // Batches far smaller than the frame: the strip spans many yields.
          internals.lineBatches.rows = 16;
          internals.stripBatches = null;
          await webgl.drawCooperative(frame);
          drewEveryRow = internals.inFlightDrewEveryRow;
          // Waiting on the last batch crossed tasks, so the canvas may have been presented:
          // the unchanged frame tone-maps the recorded density again in this task.
          while (webgl.busy) await new Promise(requestAnimationFrame);
          const drawnInstances = instances;
          webgl.draw(frame);
          if (instances !== drawnInstances || internals.inFlightDrewEveryRow) {
            throw new Error("The cooperative frame did not record its density");
          }
        } else {
          webgl.draw(frame);
          drewEveryRow = internals.inFlightDrewEveryRow;
        }
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        return { pixels, instances, calls, drewEveryRow };
      };
      const width = gl.drawingBufferWidth;
      const scale = width / source.width;
      const results: Shifted[] = [];
      for (const offset of offsets) {
        // Each move starts from a full frame of the source axes; settled frames draw every row.
        webgl.setColors(colors);
        webgl.setSelection(mask);
        await draw(source);
        if (change === "selection") webgl.setSelection(changedMask);
        if (change === "colors") webgl.setColors(changedColors);
        const shifted = await draw(
          { ...moved(offset), transient: transient ?? true },
          cooperative ?? false,
        );
        const reference = await draw(moved(offset));
        const exposed = Math.round(Math.abs(offset) * scale);
        const [from, to] = offset > 0 ? [0, exposed] : [width - exposed, width];
        let maximum = 0;
        let differing = 0;
        let stripDiffering = 0;
        let stripInk = 0;
        for (let i = 0; i < shifted.pixels.length; ++i) {
          const difference = Math.abs(shifted.pixels[i] - reference.pixels[i]);
          const column = Math.floor(i / 4) % width;
          const inStrip = column >= from && column < to;
          maximum = Math.max(maximum, difference);
          if (difference > 0) ++differing;
          if (inStrip && difference > 0) ++stripDiffering;
          if (inStrip && i % 4 === 3) stripInk += shifted.pixels[i];
        }
        results.push({
          offset,
          maximum,
          differing,
          channels: shifted.pixels.length,
          stripDiffering,
          stripInk,
          drewEveryRow: shifted.drewEveryRow,
          instances: shifted.instances,
          fullInstances: reference.instances,
          calls: shifted.calls,
        });
      }
      return results;
    },
    options,
  );
}

for (const curved of [true, false]) {
  test(`scrolled frames draw exposed columns exactly and keep the rest within three levels: ${
    curved ? "curved" : "straight"
  }`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    // Axes past both edges, as a scrolled plot wider than its canvas has them.
    const shifts = await measureShifts(page, {
      rows: 4000,
      curved,
      axes: [-150, 50, 250, 450, 650],
      offsets: [30, -30],
      missing: false,
    });
    test.info().annotations.push({ type: "shifts", description: JSON.stringify(shifts) });
    for (const shift of shifts) {
      const label = `offset ${shift.offset}`;
      expect(shift.drewEveryRow, label).toBe(false);
      expect(shift.instances, label).toBeLessThan(shift.fullInstances / 2);
      expect(shift.stripInk, label).toBeGreaterThan(0);
      expect(shift.stripDiffering, label).toBe(0);
      // A full frame converts positions to normalized device coordinates in
      // float, which a whole-pixel move does not translate exactly: moved
      // columns keep the earlier frame's picture.
      expect(shift.maximum, label).toBeLessThanOrEqual(3);
      expect(shift.differing, label).toBeLessThan(shift.channels / 1000);
    }
  });
}

test("at device pixel ratio 2, an exposed strip reached only by stubs and corners is drawn", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 640, height: 480 },
    deviceScaleFactor: 2,
  });
  try {
    const page = await context.newPage();
    // Moving right by 30 exposes 60 device columns; the first axis lands 4 CSS pixels
    // past them, so only its stub (15 pixels) and line corners reach into them.
    const shifts = await measureShifts(page, {
      rows: 3000,
      curved: true,
      axes: [4, 204, 404, 604],
      offsets: [30],
      missing: true,
    });
    test.info().annotations.push({ type: "shifts", description: JSON.stringify(shifts) });
    const [shift] = shifts;
    expect(shift.drewEveryRow).toBe(false);
    expect(shift.stripInk).toBeGreaterThan(0);
    expect(shift.stripDiffering).toBe(0);
    expect(shift.maximum).toBeLessThanOrEqual(3);
  } finally {
    await context.close();
  }
});

test("a fractional scroll move draws every row and equals a full frame", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const [shift] = await measureShifts(page, {
    rows: 2000,
    curved: true,
    axes: [-150, 50, 250, 450, 650],
    offsets: [0.5],
    missing: false,
  });
  expect(shift.drewEveryRow).toBe(true);
  expect(shift.instances).toBe(shift.fullInstances);
  expect(shift.differing).toBe(0);
});

test("an unchanged scroll frame only tone-maps its recorded density", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const [shift] = await measureShifts(page, {
    rows: 2000,
    curved: true,
    axes: [-150, 50, 250, 450, 650],
    offsets: [0],
    missing: false,
  });
  expect(shift.drewEveryRow).toBe(false);
  expect(shift.instances).toBe(0);
  expect(shift.differing).toBe(0);
});

test("a settled frame draws every row even when only its axes moved", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const shifts = await measureShifts(page, {
    rows: 2000,
    curved: true,
    axes: [-150, 50, 250, 450, 650],
    offsets: [0, 30],
    missing: false,
    transient: false,
  });
  for (const shift of shifts) {
    expect(shift.drewEveryRow, `offset ${shift.offset}`).toBe(true);
    expect(shift.instances, `offset ${shift.offset}`).toBe(shift.fullInstances);
    expect(shift.differing, `offset ${shift.offset}`).toBe(0);
  }
});

test("a sparse plot's scrolled frames draw exposed columns exactly", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const shifts = await measureShifts(page, {
    rows: 30,
    curved: true,
    axes: [-150, 50, 250, 450, 650],
    offsets: [30, -30],
    missing: false,
  });
  test.info().annotations.push({ type: "shifts", description: JSON.stringify(shifts) });
  for (const shift of shifts) expect(shift.stripDiffering).toBe(0);
});

test("the redraw after a scroll settles is a settled frame even when the clock reads early", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await loadParallelBenchmark(
    page,
    { rows: 2000, columns: 20, discrete: false, seed: 20261109 },
    "full",
  );
  const transient = await page.evaluate(async () => {
    interface ScrollPlot {
      scroller_ref: { current: HTMLDivElement };
      scrollSettle: ReturnType<typeof setTimeout> | null;
      onScroll: () => void;
      lineFrame: (...args: unknown[]) => LineFrame;
    }
    const plot = (
      window as unknown as { __parallelProbe: { instance: { parallelPlot: () => ScrollPlot } } }
    ).__parallelProbe.instance.parallelPlot();
    const scroller = plot.scroller_ref.current;
    if (scroller.scrollWidth <= scroller.clientWidth) throw new Error("The plot does not scroll");
    const frames: boolean[] = [];
    const lineFrame = plot.lineFrame.bind(plot);
    plot.lineFrame = (...args) => {
      const frame = lineFrame(...args);
      frames.push(frame.transient);
      return frame;
    };
    scroller.scrollLeft = 100;
    plot.onScroll();
    // From here on the clock reads a second early, as a coarsened or jittered one can.
    const now = performance.now.bind(performance);
    performance.now = () => now() - 1000;
    while (plot.scrollSettle !== null) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return frames;
  });
  expect(transient[0]).toBe(true);
  expect(transient[transient.length - 1]).toBe(false);
});

for (const change of ["selection", "colors"] as const) {
  test(`a scroll frame after a ${change} change draws every row`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    const [shift] = await measureShifts(page, {
      rows: 2000,
      curved: true,
      axes: [-150, 50, 250, 450, 650],
      offsets: [30],
      missing: false,
      change,
    });
    expect(shift.drewEveryRow).toBe(true);
    expect(shift.instances).toBe(shift.fullInstances);
    expect(shift.differing).toBe(0);
  });
}

test("a scroll frame drawn in many cooperative batches draws exposed columns exactly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const shifts = await measureShifts(page, {
    rows: 4000,
    curved: true,
    axes: [-150, 50, 250, 450, 650],
    offsets: [30, -30],
    missing: true,
    cooperative: true,
  });
  test.info().annotations.push({ type: "shifts", description: JSON.stringify(shifts) });
  for (const shift of shifts) {
    const label = `offset ${shift.offset}`;
    expect(shift.drewEveryRow, label).toBe(false);
    expect(shift.calls, label).toBeGreaterThan(3);
    expect(shift.stripInk, label).toBeGreaterThan(0);
    expect(shift.stripDiffering, label).toBe(0);
    expect(shift.maximum, label).toBeLessThanOrEqual(3);
  }
});
