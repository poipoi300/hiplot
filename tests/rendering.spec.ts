import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { scrollAxesToEnd } from "./plot";

interface ParallelPlotHandle {
  webgl: unknown;
  foreground: unknown;
  redrawLines: () => void;
  foreground_ref: { current: HTMLCanvasElement | null };
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => ParallelPlotHandle | null };
}

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/** Counts the line canvas pixels that are not transparent, right after a redraw. */
async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    const canvas = pp?.foreground_ref.current;
    if (!pp || !canvas) {
      throw new Error("No parallel plot");
    }
    pp.redrawLines();
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) {
      throw new Error("No 2D context");
    }
    // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) {
      painted += data[i] > 0 ? 1 : 0;
    }
    return painted;
  });
}

async function renderer(page: Page): Promise<"webgl" | "canvas"> {
  return page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    return pp.webgl !== null ? "webgl" : "canvas";
  });
}

test("parallel lines are drawn with WebGL when it is available", async ({ page }) => {
  await loadDemo(page);
  expect(await renderer(page)).toBe("webgl");
  expect(await paintedPixels(page)).toBeGreaterThan(1000);
});

test("parallel lines fall back to Canvas 2D without WebGL2", async ({ page }) => {
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
  await loadDemo(page);
  expect(await renderer(page)).toBe("canvas");
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(1000);

  // Brushing still selects and redraws through the fallback.
  const countLine = page.getByTestId("selection-count");
  const before = await countLine.textContent();
  // The first overlay is the rightmost axis, out of view when the axes scroll.
  await scrollAxesToEnd(page);
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").first();
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countLine.textContent()).not.toBe(before);
});

interface CoverageProbe {
  position: (dimension: string) => number;
  yscale: { [dimension: string]: (value: number) => number };
  scrollLeft: number;
  pixelRatio: number;
  state: { dimensions: string[] };
}

test("a steep straight line keeps its width instead of breaking into dots", async ({ page }) => {
  // Two mirrored rows over twelve close axes: each runs from the bottom of an
  // axis to the top of the next, so every segment is steep.
  const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const rising = names.map((_, i) => i % 2);
  const falling = names.map((_, i) => 1 - (i % 2));
  await page.goto("/?provider=upload");
  await page.locator("input[type=file]").setInputFiles({
    name: "steep.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([names, rising, falling].map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await page.getByRole("button", { name: "Straight", exact: true }).click();

  // Coverage of the rising line per pixel row, in a window around where it
  // crosses the row, over the part of the gap the other line keeps clear of.
  const rowSums = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
      | (ParallelPlotHandle & CoverageProbe)
      | null;
    const canvas = pp?.foreground_ref.current;
    if (!pp || !canvas) {
      throw new Error("No parallel plot");
    }
    pp.redrawLines();
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) {
      throw new Error("No 2D context");
    }
    context.drawImage(canvas, 0, 0);
    const [first, second] = pp.state.dimensions;
    const ratio = pp.pixelRatio;
    const left = (pp.position(first) - pp.scrollLeft) * ratio;
    const right = (pp.position(second) - pp.scrollLeft) * ratio;
    const bottom = pp.yscale[first](0) * ratio;
    const top = pp.yscale[second](1) * ratio;
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const sums: number[] = [];
    for (
      let y = Math.round(bottom - 0.1 * (bottom - top));
      y > bottom - 0.4 * (bottom - top);
      --y
    ) {
      const crossing = left + ((bottom - y) / (bottom - top)) * (right - left);
      let sum = 0;
      for (let x = Math.floor(crossing) - 3; x <= Math.ceil(crossing) + 3; ++x) {
        sum += data[(y * copy.width + x) * 4 + 3];
      }
      sums.push(sum);
    }
    return sums;
  });
  expect(rowSums.length).toBeGreaterThan(40);
  expect(Math.min(...rowSums)).toBeGreaterThan(0.6 * Math.max(...rowSums));
});

interface BundleProbe {
  props: { rows_filtered: ReadonlyArray<Record<string, number>> };
}

for (const deviceScaleFactor of [0.5, 1, 2]) {
  test.describe(`at device pixel ratio ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });

    test("a bundle of identical steep lines keeps the anti-aliased edge of one line", async ({
      page,
    }) => {
      // Two hundred identical rows zigzag from the bottom of each axis to the
      // top of the next; one mirrored row gives every axis its range. The
      // bundle is dense enough for the tone mapping to saturate.
      const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
      const bundle = names.map((_, i) => i % 2);
      const mirrored = names.map((_, i) => 1 - (i % 2));
      const rows = [...Array.from({ length: 200 }, () => bundle), mirrored];
      // The rows' uids, their index, would be an axis of their own, fanning the bundle out.
      await page.goto(`/?provider=upload&hip.PARALLEL_PLOT.hide=${encodeURIComponent('["uid"]')}`);
      await page.locator("input[type=file]").setInputFiles({
        name: "bundle.csv",
        mimeType: "text/csv",
        buffer: Buffer.from([names, ...rows].map((row) => row.join(",")).join("\n")),
      });
      await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
      await page.getByRole("button", { name: "Straight", exact: true }).click();

      // Per pixel row, the bundle's opacity summed in a window around where it
      // crosses the row, next to the same sum for Canvas 2D's anti-aliased
      // stroke of one opaque line along the same segment.
      const rowSums = await page.evaluate(() => {
        const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
          | (ParallelPlotHandle & CoverageProbe & BundleProbe)
          | null;
        const canvas = pp?.foreground_ref.current;
        if (!pp || !canvas) {
          throw new Error("No parallel plot");
        }
        pp.redrawLines();
        const opacities = (draw: (context: CanvasRenderingContext2D) => void) => {
          const copy = document.createElement("canvas");
          copy.width = canvas.width;
          copy.height = canvas.height;
          const context = copy.getContext("2d");
          if (context === null) {
            throw new Error("No 2D context");
          }
          draw(context);
          return context.getImageData(0, 0, copy.width, copy.height).data;
        };
        const [first, second] = pp.state.dimensions;
        const row = pp.props.rows_filtered[0];
        const ratio = pp.pixelRatio;
        const start = [
          (pp.position(first) - pp.scrollLeft) * ratio,
          pp.yscale[first](row[first]) * ratio,
        ];
        const end = [
          (pp.position(second) - pp.scrollLeft) * ratio,
          pp.yscale[second](row[second]) * ratio,
        ];
        // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
        const drawn = opacities((context) => context.drawImage(canvas, 0, 0));
        const reference = opacities((context) => {
          context.lineWidth = ratio;
          context.strokeStyle = "#fff";
          context.beginPath();
          context.moveTo(start[0], start[1]);
          context.lineTo(end[0], end[1]);
          context.stroke();
        });
        // From 10% to 40% of the way along the segment, clear of the axes and
        // of the mirrored line, which crosses the bundle halfway.
        const sums: { drawn: number; reference: number }[] = [];
        const [from, to] = [0.1, 0.4].map((t) => start[1] + t * (end[1] - start[1]));
        for (let y = Math.ceil(Math.min(from, to)); y < Math.max(from, to); ++y) {
          const t = (y + 0.5 - start[1]) / (end[1] - start[1]);
          const crossing = Math.round(start[0] + t * (end[0] - start[0]));
          const sum = { drawn: 0, reference: 0 };
          for (let x = crossing - 4; x <= crossing + 4; ++x) {
            const alpha = (y * canvas.width + x) * 4 + 3;
            sum.drawn += drawn[alpha] / 255;
            sum.reference += reference[alpha] / 255;
          }
          sums.push(sum);
        }
        return sums;
      });
      expect(rowSums.length).toBeGreaterThan(40 * deviceScaleFactor);
      // A saturated bundle drawn without anti-aliasing covers two full pixels
      // per row where the stroke covers one in total, spread over its edge.
      for (const { drawn, reference } of rowSums) {
        expect(drawn / reference).toBeGreaterThan(0.85);
        expect(drawn / reference).toBeLessThan(1.15);
      }
    });

    test("a dense bundle of identical lines keeps one color along its length", async ({ page }) => {
      // Five thousand rows share one segment and one color: every pixel the
      // bundle crosses sums thousands of coverages, where a half-float sum
      // stops growing at a point that depends on the pixel's coverage.
      const bundle = Array.from({ length: 5000 }, () => [0, 3, 0.5]);
      await uploadRows(page, ["a", "b", "c"], [...bundle, ...RANGE_ROWS], "c");
      const profile = await segmentProfile(page);
      expect(profile.length).toBeGreaterThan(40 * deviceScaleFactor);
      const median = (values: number[]) => [...values].sort((x, y) => x - y)[values.length >> 1];
      for (const channel of [0, 1, 2]) {
        const values = profile.map((column) => column.color[channel]);
        const center = median(values);
        expect(Math.max(...values.map((value) => Math.abs(value - center)))).toBeLessThan(6);
      }
    });
  });
}

/**
 * Rows that give the axes of `a` (0 to 1), `b` (0 to 10) and the color column
 * `c` (0 to 1, with enough distinct values to stay numeric) their ranges. In
 * either axis order none comes near the middle of the segment from a = 0 to
 * b = 3: they run along the top and bottom of the plot.
 */
const RANGE_ROWS = [
  [0, 0, 0],
  [1, 10, 0.25],
  [1, 10, 0.6],
  [1, 10, 0.75],
  [1, 10, 1],
];

/** Loads `rows` of the `names` columns from a CSV upload, colored by `colorBy`, straight lines. */
async function uploadRows(
  page: Page,
  names: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  colorBy: string,
): Promise<void> {
  const hidden = encodeURIComponent(JSON.stringify(["uid", colorBy]));
  await page.goto(
    `/?provider=upload&hip.PARALLEL_PLOT.hide=${hidden}&hip.color_by=${encodeURIComponent(JSON.stringify(colorBy))}`,
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "rows.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([names, ...rows].map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await page.getByRole("button", { name: "Straight", exact: true }).click();
}

/** What the line canvas shows in one device pixel column across a segment. */
interface ColumnProfile {
  /** Opacity summed over the column's window around the segment. */
  alpha: number;
  /** Opacity-weighted mean color of the window, 0-255 per channel. */
  color: [number, number, number];
}

/**
 * Per device pixel column from `from` to `to` of the way along the segment
 * of the first row between the first two axes: what the canvas shows within
 * `radius` pixels of where the segment crosses the column.
 */
async function segmentProfile(
  page: Page,
  { from = 0.1, to = 0.4, radius = 6 } = {},
): Promise<ColumnProfile[]> {
  return page.evaluate(
    ({ from, to, radius }) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
        | (ParallelPlotHandle & CoverageProbe & BundleProbe)
        | null;
      const canvas = pp?.foreground_ref.current;
      if (!pp || !canvas) {
        throw new Error("No parallel plot");
      }
      pp.redrawLines();
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) {
        throw new Error("No 2D context");
      }
      // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
      context.drawImage(canvas, 0, 0);
      const { data } = context.getImageData(0, 0, copy.width, copy.height);
      const [first, second] = pp.state.dimensions;
      const row = pp.props.rows_filtered[0];
      const ratio = pp.pixelRatio;
      const [x0, y0] = [
        (pp.position(first) - pp.scrollLeft) * ratio,
        pp.yscale[first](row[first]) * ratio,
      ];
      const [x1, y1] = [
        (pp.position(second) - pp.scrollLeft) * ratio,
        pp.yscale[second](row[second]) * ratio,
      ];
      const columns: ColumnProfile[] = [];
      for (let x = Math.ceil(x0 + from * (x1 - x0)); x < x0 + to * (x1 - x0); ++x) {
        const crossing = y0 + ((x + 0.5 - x0) / (x1 - x0)) * (y1 - y0);
        const column: ColumnProfile = { alpha: 0, color: [0, 0, 0] };
        for (let y = Math.floor(crossing) - radius; y <= Math.ceil(crossing) + radius; ++y) {
          const index = (y * copy.width + x) * 4;
          const alpha = data[index + 3] / 255;
          column.alpha += alpha;
          for (const channel of [0, 1, 2]) {
            column.color[channel] += data[index + channel] * alpha;
          }
        }
        column.color = column.color.map((sum) => sum / column.alpha) as [number, number, number];
        columns.push(column);
      }
      return columns;
    },
    { from, to, radius },
  );
}
