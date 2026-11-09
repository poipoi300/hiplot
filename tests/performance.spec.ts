import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

interface DrawnFrame {
  draft: boolean;
  resolution: number;
  drawnRows: number;
}
interface QualityProbe {
  webgl: {
    draw: (frame: DrawnFrame) => void;
    finishedFrame: () => { milliseconds: number; fullQuality: boolean } | null;
  };
  interacting: boolean;
  redrawLines: () => void;
  state: { slowFrames: boolean };
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => QualityProbe | null };
  __frames?: DrawnFrame[];
}

/** Uploads `count` rows of three numeric columns, with the given URL state. */
async function upload(page: Page, count: number, state = ""): Promise<void> {
  await page.goto(`/?provider=upload${state}`);
  const rows = Array.from({ length: count }, (_, i) => `${i % 97},${(i * 7) % 101},${i % 89}`);
  await page.locator("input[type=file]").setInputFiles({
    name: "rows.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(["a,b,c", ...rows].join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/** Records every frame the renderer is asked to draw, in window.__frames. */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as HiPlotWindow;
    const pp = win.hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    win.__frames = [];
    const draw = pp.webgl.draw.bind(pp.webgl);
    pp.webgl.draw = (frame) => {
      win.__frames?.push({
        draft: frame.draft,
        resolution: frame.resolution,
        drawnRows: frame.drawnRows,
      });
      draw(frame);
    };
  });
}

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as HiPlotWindow).__frames ?? []);

const qualityButton = (page: Page) => page.getByTestId("render-quality-button");

test("the quality control stays hidden while drawing is fast", async ({ page }) => {
  await upload(page, 200);
  await expect(page.locator("svg g.dimension").first()).toBeAttached();
  await expect(qualityButton(page)).toHaveCount(0);
});

test("forced low-performance frames draw a sample at half resolution, then a full picture", async ({
  page,
}) => {
  await upload(page, 12_000, `&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`);
  await expect(qualityButton(page)).toHaveText(/Low-performance mode/);
  await recordFrames(page);
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").first();
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 6 });
  await expect
    .poll(async () => (await frames(page)).filter((frame) => frame.resolution < 1).length)
    .toBeGreaterThan(0);
  const during = (await frames(page)).filter((frame) => frame.resolution < 1);
  expect(during.every((frame) => frame.draft && frame.drawnRows === 10_000)).toBe(true);
  await page.mouse.up();
  await expect
    .poll(async () => (await frames(page)).slice(-1)[0])
    .toEqual({ draft: false, resolution: 1, drawnRows: 12_000 });
});

test("slow frames switch low-performance mode on, and the menu can force full quality", async ({
  page,
}) => {
  await upload(page, 200);
  // Every frame reports 200 ms on the GPU.
  await page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    pp.webgl.finishedFrame = () => ({ milliseconds: 200, fullQuality: true });
    for (let i = 0; i < 5; ++i) {
      pp.redrawLines();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  });
  await expect(qualityButton(page)).toHaveText(/Low-performance mode/);

  await qualityButton(page).click();
  await page.getByRole("radio", { name: "Always full quality" }).click();
  await expect(qualityButton(page)).toHaveText(/Full quality/);
  await expect.poll(() => decodeURIComponent(page.url())).toContain('renderQuality="full"');
});

test("scrolling the axes draws low-performance frames, then a full picture once it stops", async ({
  page,
}) => {
  const columns = Array.from({ length: 40 }, (_, i) => `m${i}`);
  await page.goto(
    `/?provider=upload&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`,
  );
  const rows = Array.from({ length: 50 }, (_, r) => columns.map((_, c) => (r * (c + 3)) % 31));
  await page.locator("input[type=file]").setInputFiles({
    name: "wide.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([columns, ...rows].map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await recordFrames(page);
  await page.getByTestId("pplot-scroller").evaluate((scroller) => {
    scroller.scrollLeft = 300;
  });
  await expect
    .poll(async () => (await frames(page)).some((frame) => frame.resolution < 1))
    .toBe(true);
  await expect.poll(async () => (await frames(page)).slice(-1)[0]?.resolution).toBe(1);
});
