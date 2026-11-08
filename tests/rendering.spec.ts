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
