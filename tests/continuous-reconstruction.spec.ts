import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { ContinuousRenderer } from "../src/parallel/continuous_worker";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface ReconstructionProbe {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousFrame: number;
        continuousMetrics: ContinuousImage;
        continuous: Pick<ContinuousRenderer, "draw" | "busy">;
      };
    };
  };
  __reconstructionCase: { frame: LineFrame; colors: LineColors; selection: Uint8Array };
  __reconstructionDraft: Uint8ClampedArray;
}

for (const curved of [false, true]) {
  test(`six-column ${curved ? "eased" : "straight"} worker images retain the idle brush envelope`, async ({
    page,
  }) => {
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      "low",
    );
    const before = await page.evaluate((curved) => {
      const win = window as unknown as ReconstructionProbe;
      const plot = win.__parallelProbe.instance.parallelPlot();
      const bins = 256;
      const rows = bins * bins;
      const left = Float32Array.from(
        { length: rows },
        (_, row) => (Math.floor(row / bins) * 128) / (bins - 1),
      );
      const right = Float32Array.from(
        { length: rows },
        (_, row) => ((row % bins) * 128) / (bins - 1),
      );
      const selection = Uint8Array.from({ length: rows }, (_, row) =>
        Number(Math.floor(row / bins) >= 52 && Math.floor(row / bins) <= 166),
      );
      const selectedCount = selection.reduce((sum, value) => sum + value, 0);
      const frame: LineFrame = {
        axes: [
          { x: 0, pixels: left },
          { x: 85, pixels: right },
        ],
        width: 85,
        height: 128,
        lineWidth: 1,
        pixelRatio: 1,
        curved,
        draft: true,
        resolution: 1,
        drawnRows: rows,
        selectedCount,
        contextCount: rows - selectedCount,
        contextColor: { r: 0, g: 255, b: 0 },
        contextAlpha: 0.2,
        colorMode: "mean",
      };
      const colors: LineColors = {
        bins: new Uint32Array(rows),
        palette: [{ r: 255, g: 0, b: 0 }],
        colorMapBins: 0,
      };
      win.__reconstructionCase = { frame, colors, selection };
      plot.continuous.draw(frame, colors, selection);
      return plot.continuousFrame;
    }, curved);
    await page.waitForFunction((before) => {
      const plot = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot();
      return plot.continuousFrame > before && !plot.continuous.busy;
    }, before);
    const draft = await page.evaluate(() => {
      const win = window as unknown as ReconstructionProbe;
      const plot = win.__parallelProbe.instance.parallelPlot();
      const image = plot.continuousMetrics;
      win.__reconstructionDraft = image.pixels.slice();
      const { frame, colors, selection } = win.__reconstructionCase;
      plot.continuous.draw({ ...frame, draft: false }, colors, selection);
      return { columns: image.evaluatedColumns, rows: image.rows, after: plot.continuousFrame };
    });
    await page.waitForFunction((before) => {
      const plot = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot();
      return plot.continuousFrame > before && !plot.continuous.busy;
    }, draft.after);
    const error = await page.evaluate(() => {
      const win = window as unknown as ReconstructionProbe;
      const idle = win.__parallelProbe.instance.parallelPlot().continuousMetrics;
      const gesture = win.__reconstructionDraft;
      let absolute = 0;
      let energy = 0;
      let maximumBoundaryShift = 0;
      for (let x = 0; x < idle.width; ++x) {
        let idleBoundary = -1;
        let gestureBoundary = -1;
        for (let y = 0; y < idle.height; ++y) {
          const offset = (y * idle.width + x) * 4;
          if (idleBoundary < 0 && idle.pixels[offset] * idle.pixels[offset + 3] > 6000)
            idleBoundary = y;
          if (gestureBoundary < 0 && gesture[offset] * gesture[offset + 3] > 6000)
            gestureBoundary = y;
          for (let channel = 0; channel < 4; ++channel) {
            const reference =
              channel === 3
                ? idle.pixels[offset + 3]
                : (idle.pixels[offset + channel] * idle.pixels[offset + 3]) / 255;
            const candidate =
              channel === 3
                ? gesture[offset + 3]
                : (gesture[offset + channel] * gesture[offset + 3]) / 255;
            absolute += Math.abs(candidate - reference);
            energy += reference;
          }
        }
        if (idleBoundary < 0 || gestureBoundary < 0) throw new Error("Blank selected boundary");
        maximumBoundaryShift = Math.max(
          maximumBoundaryShift,
          Math.abs(idleBoundary - gestureBoundary),
        );
      }
      return { relative: absolute / energy, maximumBoundaryShift, columns: idle.evaluatedColumns };
    });
    await test.info().attach("gesture-idle-error", {
      body: JSON.stringify({ curved, draft, ...error }),
      contentType: "application/json",
    });
    expect(draft.rows).toBe(65_536);
    expect(draft.columns).toBe(36);
    expect(error.columns).toBe(85);
    expect(error.relative).toBeLessThan(0.012);
    expect(error.maximumBoundaryShift).toBeLessThanOrEqual(2);
  });
}

for (const kind of ["crossing", "near-crossing", "stationary-context"] as const) {
  test(`worker reconstruction preserves ${kind} geometry`, async ({ page }) => {
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      "low",
    );
    const before = await page.evaluate((kind) => {
      const plot = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot();
      const left: number[] = [];
      const right: number[] = [];
      const selected: number[] = [];
      const add = (a: number, b: number, selection: number, count = 1) => {
        for (let row = 0; row < count; ++row) {
          left.push(a);
          right.push(b);
          selected.push(selection);
        }
      };
      for (let a = 200; a < 256; ++a) for (let b = 200; b < 256; ++b) add(a, b, 0);
      add(0, 255, 1, 1000);
      if (kind === "crossing") add(255, 0, 1, 1000);
      else if (kind === "near-crossing") add(87, 0, 1, 1000);
      else add(56, 56, 0, 10_000);
      const width = kind === "crossing" ? 80 : 32;
      const selectedCount = selected.reduce((sum, value) => sum + value, 0);
      plot.continuous.draw(
        {
          axes: [
            { x: 0, pixels: new Float32Array(left) },
            { x: width, pixels: new Float32Array(right) },
          ],
          width,
          height: 255,
          lineWidth: 1,
          pixelRatio: 1,
          curved: false,
          draft: true,
          resolution: 1,
          drawnRows: left.length,
          selectedCount,
          contextCount: left.length - selectedCount,
          contextColor: { r: 0, g: 255, b: 0 },
          contextAlpha: kind === "stationary-context" ? 0.2 : 0,
          colorMode: "mean",
        },
        { bins: new Uint32Array(left.length), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
        new Uint8Array(selected),
      );
      return plot.continuousFrame;
    }, kind);
    await page.waitForFunction((before) => {
      const plot = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot();
      return plot.continuousFrame > before && !plot.continuous.busy;
    }, before);
    const rgba = await page.evaluate((kind) => {
      const image = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot().continuousMetrics;
      const offset =
        kind === "crossing"
          ? (120 * image.width + 32) * 4
          : kind === "near-crossing"
            ? (30 * image.width + 1) * 4
            : (56 * image.width + 15) * 4;
      return Array.from(image.pixels.slice(offset, offset + 4));
    }, kind);
    if (kind !== "stationary-context") expect(rgba).toEqual([0, 0, 0, 0]);
    else {
      expect(rgba.slice(0, 3)).toEqual([0, 255, 0]);
      expect(rgba[3]).toBeGreaterThan(0);
    }
    if (kind === "near-crossing") {
      const coverage = await page.evaluate(() => {
        const image = (
          window as unknown as ReconstructionProbe
        ).__parallelProbe.instance.parallelPlot().continuousMetrics;
        return [
          [1, 12],
          [1, 83],
          [8, 67],
        ].map(([x, y]) => image.pixels[(y * image.width + x) * 4 + 3]);
      });
      for (const alpha of coverage) expect(alpha).toBeGreaterThan(0);
    }
  });
}

test("draft reconstruction retains the device maximum pair width", async ({ page }) => {
  await loadParallelBenchmark(
    page,
    { rows: 3, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  const request = await page.evaluate(() => {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
    if (gl === null) throw new Error("No WebGL2 capacity reference");
    const width = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const rows = 600;
    const selected = Uint8Array.from({ length: rows }, (_, row) =>
      Number(Math.floor(row / 25) >= 8 && Math.floor(row / 25) <= 15),
    );
    const plot = (window as unknown as ReconstructionProbe).__parallelProbe.instance.parallelPlot();
    plot.continuous.draw(
      {
        axes: [
          {
            x: 0,
            pixels: Float32Array.from({ length: rows }, (_, row) => Math.floor(row / 25) / 6),
          },
          { x: width, pixels: Float32Array.from({ length: rows }, (_, row) => (row % 25) / 6) },
        ],
        width,
        height: 4,
        lineWidth: 1,
        pixelRatio: 1,
        curved: false,
        draft: true,
        resolution: 1,
        drawnRows: rows,
        selectedCount: 200,
        contextCount: 400,
        contextColor: { r: 0, g: 255, b: 0 },
        contextAlpha: 0.2,
        colorMode: "mean",
      },
      { bins: new Uint32Array(rows), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
      selected,
    );
    return { before: plot.continuousFrame, width };
  });
  await Promise.race([
    page.waitForFunction((before) => {
      const plot = (
        window as unknown as ReconstructionProbe
      ).__parallelProbe.instance.parallelPlot();
      return plot.continuousFrame > before && !plot.continuous.busy;
    }, request.before),
    page.waitForEvent("pageerror").then((error) => {
      throw error;
    }),
  ]);
  const image = await page.evaluate(() => {
    const image = (window as unknown as ReconstructionProbe).__parallelProbe.instance.parallelPlot()
      .continuousMetrics;
    return {
      width: image.width,
      height: image.height,
      rows: image.rows,
      columns: image.evaluatedColumns,
      nonblank: image.pixels.some((value) => value > 0),
    };
  });
  expect(image).toEqual({
    width: request.width,
    height: 4,
    rows: 600,
    columns: Math.ceil(request.width / 16) + 30,
    nonblank: true,
  });
});
