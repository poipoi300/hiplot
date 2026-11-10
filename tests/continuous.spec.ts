import type { Page } from "@playwright/test";
import { loadParallelBenchmark } from "../bench/parallel";
import type { ParamScale } from "../src/infertypes";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { ContinuousRenderer } from "../src/parallel/continuous_worker";
import type { LineGeometry } from "../src/parallel/geometry";
import type { BrushMasks } from "../src/parallel/selection";
import type { LineColors, LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import type { Datapoint } from "../src/types";
import { expect, test } from "./fixtures";

interface PlotProbe {
  webgl: WebGLLineRenderer;
  continuous: Pick<ContinuousRenderer, "draw" | "busy"> | null;
  continuousFrame: number;
  continuousMetrics: ContinuousImage | null;
  state: { dimensions: string[]; lineShape: string };
  props: {
    rows_filtered: Datapoint[];
    params_def: Record<string, { numeric: boolean }>;
    get_color_for_row: (row: Datapoint, opacity: number) => string;
  };
  yscale: Record<string, ParamScale>;
  h: number;
  scrollLeft: number;
  root_ref: { current: HTMLDivElement };
  foreground_ref: { current: HTMLCanvasElement };
  highlighted_ref: { current: HTMLCanvasElement };
  highlighted: CanvasRenderingContext2D;
  geometry: () => LineGeometry;
  lineColors: (geometry: LineGeometry) => LineColors;
  lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  position: (dimension: string) => number;
  xPosition: (dimension: string) => number;
  hoverAt: (x: number, y: number) => void;
  curvedLines: () => boolean;
  drawWithWebGL: (webgl: WebGLLineRenderer) => void;
}
interface CanvasPlotProbe extends Omit<PlotProbe, "webgl"> {
  webgl: null;
  brushMasks: () => BrushMasks;
  pplot: { brush: (publish: boolean) => void };
  startBrushGesture: (event: { sourceEvent: { target: Element }; y: number }, axis: string) => void;
  continueBrushGesture: (y: number) => void;
  cancelBrushMove: () => void;
  endBrushGesture: () => void;
}
interface CanvasWindow {
  hiplot_last_instance: {
    parallelPlot: () => CanvasPlotProbe;
    state: { rows_selected: Datapoint[] };
  };
}
interface Image {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}
interface ProbeWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => PlotProbe;
      state: { rows_highlighted: Datapoint[] };
    };
  };
  __continuousImages?: Record<string, Image>;
  __sourceColumns?: { column: Float32Array; length: number; samples: number[] }[];
  __sourceBins?: { bins: Uint32Array; length: number; samples: number[] };
  __latestRequest?: { frame: LineFrame; colors: LineColors; mask: Uint8Array };
  __highlightCommands?: [string, ...number[]][];
}

async function waitForContinuous(page: Page, after = 0): Promise<void> {
  await page.waitForFunction((after) => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    return (
      pp.continuousFrame > after && pp.continuous !== null && !pp.continuous.busy && !pp.webgl.busy
    );
  }, after);
}

async function saveImage(page: Page, name: string, exact: boolean): Promise<void> {
  await page.evaluate(
    ({ name, exact }) => {
      const win = window as unknown as ProbeWindow;
      const pp = win.__parallelProbe.instance.parallelPlot();
      if (exact) {
        pp.drawWithWebGL(pp.webgl);
      } else {
        const image = pp.continuousMetrics;
        if (image === null) throw new Error("No accepted density image");
        pp.webgl.present(image.pixels, image.width, image.height);
      }
      const canvas = pp.foreground_ref.current;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) throw new Error("No readback context");
      context.drawImage(canvas, 0, 0);
      win.__continuousImages ??= {};
      win.__continuousImages[name] = {
        pixels: context.getImageData(0, 0, copy.width, copy.height).data,
        width: copy.width,
        height: copy.height,
      };
    },
    { name, exact },
  );
}

test("the all-row worker preserves dense populations across row-order permutations", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 8192, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  for (const order of ["alternating", "grouped", "shuffled"] as const) {
    const before = await page.evaluate((order) => {
      const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      const perGroup = 4096;
      const rows = perGroup * 2;
      const indices = Uint32Array.from({ length: rows }, (_, row) => row);
      if (order === "shuffled") {
        let seed = 20261110;
        for (let index = rows - 1; index > 0; --index) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const other = seed % (index + 1);
          [indices[index], indices[other]] = [indices[other], indices[index]];
        }
      }
      const left = new Float32Array(rows);
      const right = new Float32Array(rows);
      const bins = new Uint32Array(rows);
      for (let row = 0; row < rows; ++row) {
        const source = indices[row];
        const group = order === "alternating" ? source % 2 : Math.floor(source / perGroup);
        const member = order === "alternating" ? Math.floor(source / 2) : source % perGroup;
        left[row] = group * 128 + Math.floor(member / 64) + 0.5;
        right[row] = group * 128 + (member % 64) + 0.5;
        bins[row] = group;
      }
      const geometry = pp.geometry();
      const mask = new Uint8Array(rows).fill(1);
      pp.continuous?.draw(
        {
          ...pp.lineFrame(geometry, mask),
          axes: [
            { x: 20, pixels: left },
            { x: 80, pixels: right },
          ],
          width: 100,
          height: 256,
          lineWidth: 1,
          draft: false,
        },
        {
          bins,
          palette: [
            { r: 255, g: 0, b: 0 },
            { r: 0, g: 0, b: 255 },
          ],
          colorMapBins: 0,
        },
        mask,
      );
      return pp.continuousFrame;
    }, order);
    await waitForContinuous(page, before);
    const result = await page.evaluate((order) => {
      const win = window as unknown as ProbeWindow;
      const pp = win.__parallelProbe.instance.parallelPlot();
      const image = pp.continuousMetrics;
      if (image === null) throw new Error("Missing population image");
      win.__continuousImages ??= {};
      win.__continuousImages[order] = { ...image, pixels: image.pixels.slice() };
      const reference = win.__continuousImages.alternating;
      let maximumDifference = 0;
      for (let channel = 0; channel < image.pixels.length; ++channel) {
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(image.pixels[channel] - reference.pixels[channel]),
        );
      }
      const alpha = [0, 0];
      const wrongColor = [0, 0];
      for (let group = 0; group < 2; ++group) {
        for (let y = group * 128; y < group * 128 + 64; ++y) {
          for (let x = 35; x < 65; ++x) {
            const pixel = (y * image.width + x) * 4;
            alpha[group] += image.pixels[pixel + 3];
            if (image.pixels[pixel + 3] > 0)
              wrongColor[group] += image.pixels[pixel + (group === 0 ? 2 : 0)];
          }
        }
      }
      return { maximumDifference, alpha, wrongColor, rows: image.rows };
    }, order);
    expect(result.rows).toBe(8192);
    expect(result.alpha[0]).toBeGreaterThan(100_000);
    expect(result.alpha[1]).toBeGreaterThan(100_000);
    expect(result.wrongColor).toEqual([0, 0]);
    expect(result.maximumDifference).toBeLessThanOrEqual(1);
  }
  const image = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const image = pp.continuousMetrics;
    if (image === null) throw new Error("Missing population image");
    pp.webgl.present(image.pixels, image.width, image.height);
    return pp.foreground_ref.current.toDataURL("image/png");
  });
  await test.info().attach("dense-populations", {
    body: Buffer.from(image.split(",")[1], "base64"),
    contentType: "image/png",
  });
});

test("an idle all-row brush starts before RAF and busy moves remain coalesced", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 50_000, columns: 4, discrete: false, seed: 20261109 },
    "low",
  );
  const result = await page.evaluate(() => {
    const pp = (
      window as unknown as ProbeWindow
    ).__parallelProbe.instance.parallelPlot() as PlotProbe &
      Pick<CanvasPlotProbe, "startBrushGesture" | "continueBrushGesture" | "endBrushGesture"> & {
        brushMoveFrame: number | null;
      };
    if (pp.continuous === null) throw new Error("No continuous renderer");
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) throw new Error("No brush overlay");
    const draw = pp.continuous.draw.bind(pp.continuous);
    let requests = 0;
    pp.continuous.draw = (...args) => {
      requests += 1;
      draw(...args);
    };
    pp.startBrushGesture({ sourceEvent: { target }, y: pp.h * 0.2 }, dimension);
    pp.continueBrushGesture(pp.h * 0.5);
    const first = { requests, scheduled: pp.brushMoveFrame };
    pp.continueBrushGesture(pp.h * 0.6);
    const pending = pp.brushMoveFrame;
    pp.continueBrushGesture(pp.h * 0.7);
    const busy = { requests, coalesced: pending !== null && pending === pp.brushMoveFrame };
    pp.endBrushGesture();
    return { first, busy, cancelled: pp.brushMoveFrame === null };
  });
  expect(result.first).toEqual({ requests: 1, scheduled: null });
  expect(result.busy).toEqual({ requests: 1, coalesced: true });
  expect(result.cancelled).toBe(true);
});

test("pixel-scale density agrees within two pixels and 6.5% relative tolerance", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 300, columns: 4, discrete: false, seed: 20261109 });
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Straight", exact: true })
    .click();
  await saveImage(page, "exact", true);
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Continuous density", exact: true }).click();
  await waitForContinuous(page);
  await saveImage(page, "continuous", false);
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const exact = win.__continuousImages?.exact;
    const continuous = win.__continuousImages?.continuous;
    if (
      !exact ||
      !continuous ||
      exact.width !== continuous.width ||
      exact.height !== continuous.height
    ) {
      throw new Error("Comparable renderer images are missing");
    }
    const { width, height } = exact;
    // Fixed CSS-pixel tolerance cannot silently grow when endpoint bins become coarser.
    const radius = 2;
    const blur = (image: Image): Float64Array => {
      const result = new Float64Array(image.pixels.length);
      for (let x = 0; x < width; ++x) {
        for (let channel = 0; channel < 4; ++channel) {
          let sum = 0;
          const value = (y: number): number => {
            const pixel = (y * width + x) * 4;
            return channel === 3
              ? image.pixels[pixel + 3]
              : (image.pixels[pixel + channel] * image.pixels[pixel + 3]) / 255;
          };
          for (let y = 0; y <= Math.min(radius, height - 1); ++y) sum += value(y);
          for (let y = 0; y < height; ++y) {
            const count = Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1;
            result[(y * width + x) * 4 + channel] = sum / count;
            if (y - radius >= 0) sum -= value(y - radius);
            if (y + radius + 1 < height) sum += value(y + radius + 1);
          }
        }
      }
      return result;
    };
    const reference = blur(exact);
    const candidate = blur(continuous);
    const axes = pp.state.dimensions.map((dimension) => pp.position(dimension) - pp.scrollLeft);
    let error = 0;
    let energy = 0;
    let samples = 0;
    let referenceAlpha = 0;
    let candidateAlpha = 0;
    for (let x = Math.ceil(Math.min(...axes) + 10); x < Math.max(...axes) - 10; ++x) {
      if (x < 0 || x >= width || axes.some((axis) => Math.abs(x - axis) < 10)) continue;
      for (let y = 0; y < height; ++y) {
        const pixel = (y * width + x) * 4;
        referenceAlpha += reference[pixel + 3];
        candidateAlpha += candidate[pixel + 3];
        for (let channel = 0; channel < 4; ++channel) {
          error += Math.abs(candidate[pixel + channel] - reference[pixel + channel]);
          energy += reference[pixel + channel];
          samples += 1;
        }
      }
    }
    return {
      relativeError: error / energy,
      absoluteError: error / (samples * 255),
      alphaRatio: candidateAlpha / referenceAlpha,
      referenceAlpha,
      samples,
      radius,
    };
  });
  expect(result.samples).toBeGreaterThan(100_000);
  expect(result.referenceAlpha).toBeGreaterThan(100_000);
  expect(result.radius).toBeGreaterThan(1);
  await test.info().attach("density-comparison", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.relativeError).toBeLessThanOrEqual(0.065);
  expect(result.absoluteError).toBeLessThanOrEqual(2.2 / 255);
  expect(Math.abs(result.alphaRatio - 1)).toBeLessThanOrEqual(0.04);
});

test("gesture images retain every source row and refine only image columns", async ({ page }) => {
  await loadParallelBenchmark(
    page,
    { rows: 50_000, columns: 4, discrete: false, seed: 20261109 },
    "low",
  );
  const before = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const geometry = pp.geometry();
    const mask = new Uint8Array(geometry.rows.length);
    mask[mask.length - 1] = 1;
    pp.continuous?.draw(
      { ...pp.lineFrame(geometry, mask), draft: true },
      pp.lineColors(geometry),
      mask,
    );
    return pp.continuousFrame;
  });
  await waitForContinuous(page, before);
  const gesture = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const image = pp.continuousMetrics;
    if (image === null) throw new Error("No gesture image");
    const geometry = pp.geometry();
    const mask = new Uint8Array(geometry.rows.length);
    mask[mask.length - 1] = 1;
    pp.continuous?.draw(
      { ...pp.lineFrame(geometry, mask), draft: false },
      pp.lineColors(geometry),
      mask,
    );
    return {
      rows: image.rows,
      bins: image.axisBins,
      columns: image.evaluatedColumns,
      frame: pp.continuousFrame,
    };
  });
  await waitForContinuous(page, gesture.frame);
  const refined = await page.evaluate(() => {
    const image = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot()
      .continuousMetrics;
    return { rows: image?.rows, bins: image?.axisBins, columns: image?.evaluatedColumns };
  });
  expect(gesture.rows).toBe(50_000);
  expect(refined.rows).toBe(50_000);
  expect(gesture.bins).toBeGreaterThanOrEqual(256);
  expect(refined.bins).toBe(gesture.bins);
  expect(refined.columns).toBeGreaterThan(gesture.columns);
});

test("hover draws the original unquantized row exactly above the continuous picture", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 24, columns: 4, discrete: false, seed: 20261109 });
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Straight", exact: true })
    .click();
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Continuous density", exact: true }).click();
  await waitForContinuous(page);
  const uid = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    win.__highlightCommands = [];
    const context = pp.highlighted;
    const moveTo = context.moveTo.bind(context);
    const lineTo = context.lineTo.bind(context);
    const bezierCurveTo = context.bezierCurveTo.bind(context);
    context.moveTo = (x, y) => {
      win.__highlightCommands?.push(["M", x, y]);
      moveTo(x, y);
    };
    context.lineTo = (x, y) => {
      win.__highlightCommands?.push(["L", x, y]);
      lineTo(x, y);
    };
    context.bezierCurveTo = (...points) => {
      win.__highlightCommands?.push(["C", ...points]);
      bezierCurveTo(...points);
    };
    const row = pp.props.rows_filtered[0];
    const [left, right] = pp.state.dimensions;
    pp.hoverAt(
      (pp.position(left) + pp.position(right)) / 2,
      (pp.yscale[left](row[left]) + pp.yscale[right](row[right])) / 2,
    );
    return row.uid;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rows = (window as unknown as ProbeWindow).__parallelProbe.instance.state
          .rows_highlighted;
        return rows.map((row) => row.uid);
      }),
    )
    .toEqual([uid]);
  await expect(page.getByTestId("line-tooltip")).toBeVisible();
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const row = win.__parallelProbe.instance.state.rows_highlighted[0];
    const canvas = pp.highlighted_ref.current;
    const ctx = pp.highlighted;
    const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Reuse the surface: separate Canvas backends can round AA coverage one level apart.
    ctx.save();
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const points = pp.state.dimensions.map((dimension) => ({
      x: pp.xPosition(dimension) - pp.scrollLeft,
      y: pp.yscale[dimension](row[dimension]),
    }));
    const expectedCommands: [string, ...number[]][] = [
      ["M", points[0].x - 15, points[0].y],
      ...points.map(({ x, y }): [string, ...number[]] => ["L", x, y]),
      ["L", points[points.length - 1].x + 15, points[points.length - 1].y],
    ];
    const commands = win.__highlightCommands?.map((command) => [...command]);
    const commandsMatch =
      JSON.stringify(commands) === JSON.stringify([...expectedCommands, ...expectedCommands]);
    const draw = (width: number, color: string): void => {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(points[0].x - 15, points[0].y);
      for (const point of points) ctx.lineTo(point.x, point.y);
      const last = points[points.length - 1];
      ctx.lineTo(last.x + 15, last.y);
      ctx.stroke();
    };
    draw(7, getComputedStyle(pp.root_ref.current).getPropertyValue("--hip-halo"));
    draw(2.5, pp.props.get_color_for_row(row, 1));
    const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let differing = 0;
    let painted = 0;
    let alphaDifferences = 0;
    let maximumDifference = 0;
    const examples: { channel: number; expected: number; actual: number }[] = [];
    for (let channel = 0; channel < expected.length; ++channel) {
      differing += Number(expected[channel] !== actual[channel]);
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(expected[channel] - actual[channel]),
      );
      if (channel % 4 === 3 && expected[channel] > 0) painted += 1;
      if (channel % 4 === 3) alphaDifferences += Number(expected[channel] !== actual[channel]);
      if (expected[channel] !== actual[channel] && examples.length < 8)
        examples.push({ channel, expected: expected[channel], actual: actual[channel] });
    }
    const binHeight = pp.h / 32;
    return {
      differing,
      painted,
      alphaDifferences,
      maximumDifference,
      commandsMatch,
      commands,
      expectedCommands,
      examples,
      curved: pp.curvedLines(),
      savedShape: pp.state.lineShape,
      offBinCenter: points.some(
        (point) => Math.abs(point.y / binHeight - Math.floor(point.y / binHeight) - 0.5) > 0.1,
      ),
    };
  });
  expect(result.painted).toBeGreaterThan(1000);
  expect(result.offBinCenter).toBe(true);
  expect(result.savedShape).toBe("straight");
  expect(result.curved).toBe(false);
  expect(result.commandsMatch, JSON.stringify(result)).toBe(true);
  expect(result.differing, JSON.stringify(result)).toBe(0);
});

test("numeric extrema and missing-color means survive incremental removal in the worker", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 3, columns: 2, discrete: true, seed: 20261109 }, "low");
  const colors: number[][] = [];
  for (const mode of ["mean", "highest", "lowest", "remaining"] as const) {
    const before = await page.evaluate((mode) => {
      const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      const geometry = pp.geometry();
      const mask = new Uint8Array(mode === "remaining" ? [0, 1, 0] : [1, 1, 1]);
      const selectedCount = mask.reduce((sum, selected) => sum + selected, 0);
      const win = window as unknown as ProbeWindow & {
        __numericFixture?: { pixels: Float32Array; colors: LineColors };
      };
      win.__numericFixture ??= {
        pixels: new Float32Array([32, 32, 32]),
        colors: {
          bins: new Uint32Array([0, 1, 2]),
          palette: [
            { r: 255, g: 0, b: 0 },
            { r: 0, g: 0, b: 255 },
            { r: 0, g: 255, b: 0 },
          ],
          colorMapBins: 2,
        },
      };
      const { pixels } = win.__numericFixture;
      pp.continuous?.draw(
        {
          ...pp.lineFrame(geometry, mask),
          axes: [
            { x: 16, pixels },
            { x: 80, pixels },
          ],
          width: 96,
          height: 64,
          lineWidth: 1,
          curved: false,
          draft: false,
          drawnRows: 3,
          selectedCount,
          contextCount: 3 - selectedCount,
          colorMode: mode === "remaining" ? "lowest" : mode,
          contextAlpha: 0,
        },
        win.__numericFixture.colors,
        mask,
      );
      return pp.continuousFrame;
    }, mode);
    await waitForContinuous(page, before);
    colors.push(
      await page.evaluate(() => {
        const image = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot()
          .continuousMetrics;
        if (!image) throw new Error("No numeric worker image");
        const pixel = (32 * image.width + 48) * 4;
        return Array.from(image.pixels.slice(pixel, pixel + 4));
      }),
    );
  }
  const [mean, highest, lowest, remaining] = colors;
  expect(mean[3]).toBeGreaterThan(50);
  expect(Math.max(...mean.slice(0, 3)) - Math.min(...mean.slice(0, 3))).toBeLessThanOrEqual(4);
  expect(highest[2]).toBeGreaterThan(highest[0] + 100);
  expect(lowest[0]).toBeGreaterThan(lowest[2] + 100);
  expect(remaining[2]).toBeGreaterThan(remaining[0] + 100);
});

test("horizontal translation composites cached pair images without pixel evaluation", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 400, columns: 4, discrete: false, seed: 20261109 },
    "low",
  );
  const before = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const geometry = pp.geometry();
    const mask = pp.selectionMask(geometry);
    const frame = pp.lineFrame(geometry, mask);
    pp.continuous?.draw(
      { ...frame, axes: frame.axes.map((axis) => ({ ...axis, x: axis.x - 20 })) },
      pp.lineColors(geometry),
      mask,
    );
    return pp.continuousFrame;
  });
  await waitForContinuous(page, before);
  const image = await page.evaluate(() => {
    const image = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot()
      .continuousMetrics;
    return {
      evaluated: image?.evaluatedPairs,
      rows: image?.rows,
      painted: image?.pixels.some((value, channel) => channel % 4 === 3 && value > 0),
    };
  });
  expect(image.evaluated).toBe(0);
  expect(image.rows).toBe(400);
  expect(image.painted).toBe(true);
});

test("curved highlights retain identical original spline commands in both modes", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 24, columns: 4, discrete: false, seed: 20261109 });
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Curved", exact: true })
    .click();
  const trace = () =>
    page.evaluate(() => {
      const pp = (
        window as unknown as ProbeWindow
      ).__parallelProbe.instance.parallelPlot() as PlotProbe & {
        tracePath: (row: Datapoint, context: CanvasRenderingContext2D) => void;
      };
      const commands: [string, ...number[]][] = [];
      const context = pp.highlighted;
      const methods = {
        moveTo: context.moveTo,
        lineTo: context.lineTo,
        bezierCurveTo: context.bezierCurveTo,
      };
      context.moveTo = (x, y) => commands.push(["M", x, y]);
      context.lineTo = (x, y) => commands.push(["L", x, y]);
      context.bezierCurveTo = (...values) => commands.push(["C", ...values]);
      try {
        pp.tracePath(pp.props.rows_filtered[0], context);
      } finally {
        Object.assign(context, methods);
      }
      return commands;
    });
  const exact = await trace();
  expect(exact.some((command) => command[0] === "C")).toBe(true);
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Continuous density", exact: true }).click();
  await waitForContinuous(page);
  expect(await trace()).toEqual(exact);
  await expect(
    page
      .getByRole("group", { name: "Line shape" })
      .getByRole("button", { name: "Curved", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("worker coalescing presents only the latest selection without detaching source columns", async ({
  page,
}) => {
  await loadParallelBenchmark(
    page,
    { rows: 1000, columns: 4, discrete: false, seed: 20261109 },
    "low",
  );
  const initial = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const renderer = pp.continuous;
    const image = pp.continuousMetrics;
    if (renderer === null || image === null) throw new Error("No continuous renderer");
    const geometry = pp.geometry();
    win.__sourceColumns = pp.state.dimensions.map((dimension) => {
      const column = geometry.pixels(
        dimension,
        pp.yscale[dimension],
        pp.props.params_def[dimension].numeric,
      );
      return { column, length: column.byteLength, samples: [column[0], column[499], column[999]] };
    });
    const colors = pp.lineColors(geometry);
    win.__sourceBins = {
      bins: colors.bins,
      length: colors.bins.byteLength,
      samples: [colors.bins[0], colors.bins[499], colors.bins[999]],
    };
    win.__continuousImages = { initial: { ...image, pixels: image.pixels.slice() } };
    const initial = pp.continuousFrame;
    for (let step = 0; step < 20; ++step) {
      const mask = Uint8Array.from({ length: geometry.rows.length }, (_, row) =>
        Number(step === 19 ? row % 3 === 0 : row % 7 <= step % 7),
      );
      const frame = pp.lineFrame(geometry, mask);
      renderer.draw(frame, colors, mask);
      win.__latestRequest = { frame, colors, mask };
    }
    return initial;
  });
  await waitForContinuous(page, initial);
  const accepted = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    if (!win.__continuousImages || !pp.continuousMetrics || !pp.continuous || !win.__latestRequest)
      throw new Error("Missing queued frame");
    win.__continuousImages.queued = {
      ...pp.continuousMetrics,
      pixels: pp.continuousMetrics.pixels.slice(),
    };
    const accepted = pp.continuousFrame;
    const { frame, colors, mask } = win.__latestRequest;
    pp.continuous.draw(frame, colors, mask);
    return accepted;
  });
  expect(accepted - initial).toBe(1);
  await waitForContinuous(page, accepted);
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const queued = win.__continuousImages?.queued;
    const initial = win.__continuousImages?.initial;
    const fresh = pp.continuousMetrics;
    const bins = win.__sourceBins;
    if (!queued || !initial || !fresh || !bins || !win.__sourceColumns)
      throw new Error("Missing comparison state");
    let freshDifferences = 0;
    let selectionDifferences = 0;
    for (let channel = 0; channel < queued.pixels.length; ++channel) {
      freshDifferences += Number(queued.pixels[channel] !== fresh.pixels[channel]);
      selectionDifferences += Number(queued.pixels[channel] !== initial.pixels[channel]);
    }
    return {
      freshDifferences,
      selectionDifferences,
      columnsIntact: win.__sourceColumns.every(
        ({ column, length, samples }) =>
          column.byteLength === length &&
          [column[0], column[499], column[999]].every((value, index) => value === samples[index]),
      ),
      binsIntact:
        bins.bins.byteLength === bins.length &&
        [bins.bins[0], bins.bins[499], bins.bins[999]].every(
          (value, index) => value === bins.samples[index],
        ),
    };
  });
  expect(result.columnsIntact).toBe(true);
  expect(result.binsIntact).toBe(true);
  expect(result.selectionDifferences).toBeGreaterThan(1000);
  expect(result.freshDifferences).toBe(0);
});

test("the inline density worker starts and redraws without any network access", async ({
  page,
  context,
}) => {
  await loadParallelBenchmark(page, { rows: 300, columns: 4, discrete: false, seed: 20261109 });
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  await context.setOffline(true);
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Continuous density", exact: true }).click();
  await waitForContinuous(page);
  const frame = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const image = pp.continuousMetrics;
    if (image === null || pp.continuous === null)
      throw new Error("Offline worker did not produce an image");
    const geometry = pp.geometry();
    const mask = Uint8Array.from({ length: geometry.rows.length }, (_, row) => row % 2);
    pp.continuous.draw(pp.lineFrame(geometry, mask), pp.lineColors(geometry), mask);
    return pp.continuousFrame;
  });
  await waitForContinuous(page, frame);
  const painted = await page.evaluate(() =>
    (window as unknown as ProbeWindow).__parallelProbe.instance
      .parallelPlot()
      .continuousMetrics?.pixels.some((value, channel) => channel % 4 === 3 && value > 0),
  );
  expect(painted).toBe(true);
  expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
});

test("Canvas-only continuous images draw and brushes stay columnar until publication", async ({
  page,
}) => {
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
  await page.goto(
    `/?provider=upload&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`,
  );
  const rows = Array.from({ length: 200 }, (_, row) => `${row},${(row * 7) % 101},${row % 89}`);
  await page.locator("input[type=file]").setInputFiles({
    name: "canvas-density.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(["a,b,c", ...rows].join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await page.waitForFunction(() => {
    const pp = (window as unknown as CanvasWindow).hiplot_last_instance.parallelPlot();
    return pp.continuousFrame > 0 && pp.continuous !== null && !pp.continuous.busy;
  });
  const result = await page.evaluate(() => {
    const pp = (window as unknown as CanvasWindow).hiplot_last_instance.parallelPlot();
    const masks = pp.brushMasks();
    const selectedRows = masks.selectedRows.bind(masks);
    let materializations = 0;
    masks.selectedRows = (mask) => {
      materializations += 1;
      return selectedRows(mask);
    };
    const canvas = pp.foreground_ref.current;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No Canvas-only foreground context");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let channel = 3; channel < pixels.length; channel += 4)
      painted += Number(pixels[channel] > 0);
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) throw new Error("No Canvas brush overlay");
    const frame = pp.continuousFrame;
    pp.startBrushGesture({ sourceEvent: { target }, y: 0.2 * pp.h }, dimension);
    pp.continueBrushGesture(0.65 * pp.h);
    pp.cancelBrushMove();
    pp.pplot.brush(false);
    const during = materializations;
    const selected = pp.selectionMask(pp.geometry()).reduce((count, value) => count + value, 0);
    pp.endBrushGesture();
    return { webgl: pp.webgl, painted, frame, during, published: materializations, selected };
  });
  expect(result.webgl).toBeNull();
  expect(result.painted).toBeGreaterThan(1000);
  expect(result.during).toBe(0);
  expect(result.published).toBe(1);
  expect(result.selected).toBeGreaterThan(0);
  expect(result.selected).toBeLessThan(200);
  await page.waitForFunction((frame) => {
    const pp = (window as unknown as CanvasWindow).hiplot_last_instance.parallelPlot();
    return pp.continuousFrame > frame && pp.continuous !== null && !pp.continuous.busy;
  }, result.frame);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as CanvasWindow).hiplot_last_instance.state.rows_selected.length,
      ),
    )
    .toBe(result.selected);
});
