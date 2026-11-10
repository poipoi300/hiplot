import type { Page } from "@playwright/test";
import { loadParallelBenchmark } from "../bench/parallel";
import type { ParamScale } from "../src/infertypes";
import type { BinnedImage } from "../src/parallel/binned";
import type { BinnedRenderer } from "../src/parallel/binned_worker";
import type { LineGeometry } from "../src/parallel/geometry";
import type { BrushMasks } from "../src/parallel/selection";
import type { LineColors, LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import type { Datapoint } from "../src/types";
import { expect, test } from "./fixtures";

interface PlotProbe {
  webgl: WebGLLineRenderer;
  binned: Pick<BinnedRenderer, "draw" | "busy"> | null;
  binnedFrame: number;
  binnedMetrics: BinnedImage | null;
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
  __binnedImages?: Record<string, Image>;
  __sourceColumns?: { column: Float32Array; length: number; samples: number[] }[];
  __sourceBins?: { bins: Uint32Array; length: number; samples: number[] };
  __latestRequest?: { frame: LineFrame; colors: LineColors; mask: Uint8Array };
  __highlightCommands?: [string, ...number[]][];
}

async function waitForBinned(page: Page, after = 0): Promise<void> {
  await page.waitForFunction((after) => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    return pp.binnedFrame > after && pp.binned !== null && !pp.binned.busy && !pp.webgl.busy;
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
        const image = pp.binnedMetrics;
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
      win.__binnedImages ??= {};
      win.__binnedImages[name] = {
        pixels: context.getImageData(0, 0, copy.width, copy.height).data,
        width: copy.width,
        height: copy.height,
      };
    },
    { name, exact },
  );
}

test("binned straight density agrees within one-bin spatial and 20% relative tolerance", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 300, columns: 4, discrete: false, seed: 20261109 });
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Straight", exact: true })
    .click();
  await saveImage(page, "exact", true);
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Binned density", exact: true }).click();
  await waitForBinned(page);
  await saveImage(page, "binned", false);
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const exact = win.__binnedImages?.exact;
    const binned = win.__binnedImages?.binned;
    if (!exact || !binned || exact.width !== binned.width || exact.height !== binned.height) {
      throw new Error("Comparable renderer images are missing");
    }
    const { width, height } = exact;
    // Endpoints move within one histogram bin; compare that spatial scale, not hard pixel equality.
    const radius = Math.ceil(height / 32);
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
    const candidate = blur(binned);
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
  expect(result.relativeError).toBeLessThanOrEqual(0.2);
  expect(result.absoluteError).toBeLessThanOrEqual(4 / 255);
  expect(result.alphaRatio).toBeGreaterThan(0.9);
  expect(result.alphaRatio).toBeLessThan(1.1);
});

test("hover draws the original unquantized row exactly above the binned picture", async ({
  page,
}) => {
  await loadParallelBenchmark(page, { rows: 24, columns: 4, discrete: false, seed: 20261109 });
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Curved", exact: true })
    .click();
  await page.getByTestId("render-quality-button").click();
  await page.getByRole("radio", { name: "Binned density", exact: true }).click();
  await waitForBinned(page);
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
  expect(result.savedShape).toBe("curved");
  expect(result.curved).toBe(false);
  expect(result.commandsMatch, JSON.stringify(result)).toBe(true);
  expect(result.differing, JSON.stringify(result)).toBe(0);
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
    const renderer = pp.binned;
    const image = pp.binnedMetrics;
    if (renderer === null || image === null) throw new Error("No binned renderer");
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
    win.__binnedImages = { initial: { ...image, pixels: image.pixels.slice() } };
    const initial = pp.binnedFrame;
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
  await waitForBinned(page, initial);
  const accepted = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    if (!win.__binnedImages || !pp.binnedMetrics || !pp.binned || !win.__latestRequest)
      throw new Error("Missing queued frame");
    win.__binnedImages.queued = { ...pp.binnedMetrics, pixels: pp.binnedMetrics.pixels.slice() };
    const accepted = pp.binnedFrame;
    const { frame, colors, mask } = win.__latestRequest;
    pp.binned.draw(frame, colors, mask);
    return accepted;
  });
  expect(accepted - initial).toBe(1);
  await waitForBinned(page, accepted);
  const result = await page.evaluate(() => {
    const win = window as unknown as ProbeWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const queued = win.__binnedImages?.queued;
    const initial = win.__binnedImages?.initial;
    const fresh = pp.binnedMetrics;
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
  await page.getByRole("radio", { name: "Binned density", exact: true }).click();
  await waitForBinned(page);
  const frame = await page.evaluate(() => {
    const pp = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
    const image = pp.binnedMetrics;
    if (image === null || pp.binned === null)
      throw new Error("Offline worker did not produce an image");
    const geometry = pp.geometry();
    const mask = Uint8Array.from({ length: geometry.rows.length }, (_, row) => row % 2);
    pp.binned.draw(pp.lineFrame(geometry, mask), pp.lineColors(geometry), mask);
    return pp.binnedFrame;
  });
  await waitForBinned(page, frame);
  const painted = await page.evaluate(() =>
    (window as unknown as ProbeWindow).__parallelProbe.instance
      .parallelPlot()
      .binnedMetrics?.pixels.some((value, channel) => channel % 4 === 3 && value > 0),
  );
  expect(painted).toBe(true);
  expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
});

test("Canvas-only binned images draw and brushes stay columnar until publication", async ({
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
    return pp.binnedFrame > 0 && pp.binned !== null && !pp.binned.busy;
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
    const frame = pp.binnedFrame;
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
    return pp.binnedFrame > frame && pp.binned !== null && !pp.binned.busy;
  }, result.frame);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as CanvasWindow).hiplot_last_instance.state.rows_selected.length,
      ),
    )
    .toBe(result.selected);
});
