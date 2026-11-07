import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

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
