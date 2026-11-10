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
    present: (pixels: Uint8ClampedArray, width: number, height: number) => void;
    finishedFrame: () => { milliseconds: number; fullQuality: boolean } | null;
    busy: boolean;
    rowCount: number;
  };
  binned: {
    busy: boolean;
    draw: (
      frame: DrawnFrame & { selectedCount: number; contextCount: number },
      colors: unknown,
      mask: Uint8Array,
    ) => void;
  } | null;
  binnedFrame: number;
  binnedMode: () => boolean;
  interacting: boolean;
  scrollLeft: number;
  redrawLines: () => void;
  state: { slowFrames: boolean; renderQuality: string };
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => QualityProbe | null };
  __frames?: DrawnFrame[];
  __presentations?: number;
  __binnedRows?: number[];
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

async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as HiPlotWindow;
    const pp = win.hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    win.__frames = [];
    win.__presentations = 0;
    win.__binnedRows = [];
    if (pp.binned !== null) {
      const binnedDraw = pp.binned.draw.bind(pp.binned);
      pp.binned.draw = (frame, colors, mask) => {
        win.__binnedRows?.push(
          frame.drawnRows,
          mask.length,
          frame.selectedCount + frame.contextCount,
        );
        binnedDraw(frame, colors, mask);
      };
    }
    const draw = pp.webgl.draw.bind(pp.webgl);
    pp.webgl.draw = (frame) => {
      win.__frames?.push({
        draft: frame.draft,
        resolution: frame.resolution,
        drawnRows: frame.drawnRows,
      });
      draw(frame);
    };
    const present = pp.webgl.present.bind(pp.webgl);
    pp.webgl.present = (...args) => {
      win.__presentations = (win.__presentations ?? 0) + 1;
      present(...args);
    };
  });
}

async function waitForBinned(page: Page, after = 0): Promise<void> {
  await page.waitForFunction((after) => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    return pp?.binnedMode() && pp.binnedFrame > after && !pp.binned?.busy && !pp.webgl.busy;
  }, after);
}

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as HiPlotWindow).__frames ?? []);
const qualityButton = (page: Page) => page.getByTestId("render-quality-button");

async function chooseQuality(page: Page, name: string): Promise<void> {
  await qualityButton(page).click();
  await page.getByRole("radio", { name, exact: true }).click();
}

test("the quality control is available even when exact drawing is fast", async ({ page }) => {
  await upload(page, 200);
  await expect(qualityButton(page)).toHaveText("Exact lines");
  await qualityButton(page).click();
  await expect(page.getByRole("radio", { name: "Automatic", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Binned density", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Exact lines", exact: true })).toBeVisible();
});

test("forced binned density counts every row at rest, while brushing and after release", async ({
  page,
}) => {
  await upload(page, 12_000, `&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`);
  await waitForBinned(page);
  await expect(qualityButton(page)).toHaveText("Binned density");
  await recordFrames(page);
  const initial = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    const initial = pp.binnedFrame;
    pp.redrawLines();
    return initial;
  });
  await waitForBinned(page, initial);
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("No brush overlay");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 6 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as HiPlotWindow).__presentations ?? 0))
    .toBeGreaterThan(1);
  const during = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    return { frame: pp.binnedFrame, binned: pp.binnedMode(), interacting: pp.interacting };
  });
  expect(during.binned).toBe(true);
  expect(during.interacting).toBe(true);
  await page.mouse.up();
  await waitForBinned(page, during.frame);
  await expect(qualityButton(page)).toHaveText("Binned density");
  expect(await frames(page)).toEqual([]);
  const counts = await page.evaluate(() => (window as unknown as HiPlotWindow).__binnedRows ?? []);
  expect(counts.length).toBeGreaterThan(6);
  expect(counts.every((count) => count === 12_000)).toBe(true);
});

test("automatic software mode bins before drawing more than 6000 original rows", async ({
  page,
}) => {
  await upload(page, 6001);
  await waitForBinned(page);
  await expect(qualityButton(page)).toHaveText("Binned density");
  const state = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    return { quality: pp.state.renderQuality, uploadedOriginalRows: pp.webgl.rowCount };
  });
  expect(state).toEqual({ quality: "auto", uploadedOriginalRows: 0 });
});

test("slow exact frames engage automatic binning and the menu can force exact lines", async ({
  page,
}) => {
  await upload(page, 200);
  await recordFrames(page);
  await page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    pp.webgl.finishedFrame = () => ({ milliseconds: 200, fullQuality: true });
    for (let i = 0; i < 5; ++i) {
      pp.redrawLines();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  });
  await waitForBinned(page);
  await expect(qualityButton(page)).toHaveText("Binned density");
  await chooseQuality(page, "Exact lines");
  await expect(qualityButton(page)).toHaveText("Exact lines");
  await expect.poll(() => decodeURIComponent(page.url())).toContain('renderQuality="full"');
  expect((await frames(page)).slice(-1)[0]).toEqual({
    draft: false,
    resolution: 1,
    drawnRows: 200,
  });
  expect(
    await page.evaluate(() => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
      return pp?.binned === null && pp.state.slowFrames;
    }),
  ).toBe(true);
});

test("scrolling and its settle redraw remain binned without sampling or exact-row draws", async ({
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
  await waitForBinned(page);
  await recordFrames(page);
  const initial = await page.evaluate(
    () =>
      (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot()?.binnedFrame ?? 0,
  );
  await page.getByTestId("pplot-scroller").evaluate((scroller) => {
    scroller.scrollLeft = 300;
  });
  await waitForBinned(page, initial);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as HiPlotWindow).__presentations ?? 0))
    .toBeGreaterThanOrEqual(2);
  await expect(qualityButton(page)).toHaveText("Binned density");
  expect(await frames(page)).toEqual([]);
});

test("continuous brushing presents density while worker jobs are slower than input", async ({
  page,
}) => {
  await upload(page, 12_000, `&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`);
  await waitForBinned(page);
  const result = await page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
      | (QualityProbe & {
          h: number;
          state: QualityProbe["state"] & { dimensions: string[] };
          startBrushGesture: (
            event: { sourceEvent: { target: Element }; y: number },
            dimension: string,
          ) => void;
          continueBrushGesture: (y: number) => void;
          endBrushGesture: () => void;
        })
      | null;
    if (!pp || pp.binned === null) throw new Error("No binned parallel plot");
    const dimension = pp.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) throw new Error("No continuous brush overlay");
    const postMessage = Worker.prototype.postMessage;
    let workerJobs = 0;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      workerJobs += 1;
      const send = postMessage.bind(this);
      setTimeout(() => {
        if (Array.isArray(options)) send(message, options);
        else send(message, options);
      }, 80);
    };
    const initialFrame = pp.binnedFrame;
    const started = performance.now();
    let movements = 0;
    pp.startBrushGesture({ sourceEvent: { target }, y: 0.2 * pp.h }, dimension);
    await new Promise<void>((resolve) => {
      const move = (): void => {
        const elapsed = performance.now() - started;
        // Exercise five jobs even when the full suite contends for the software GPU.
        if ((elapsed >= 1500 && workerJobs >= 5 && movements >= 30) || elapsed >= 10000) {
          resolve();
          return;
        }
        pp.continueBrushGesture(pp.h * (0.5 + 0.2 * Math.sin(movements / 7)));
        movements += 1;
        requestAnimationFrame(move);
      };
      requestAnimationFrame(move);
    });
    const during = {
      acceptedFrames: pp.binnedFrame - initialFrame,
      movements,
      workerJobs,
      elapsed: performance.now() - started,
      interacting: pp.interacting,
    };
    Worker.prototype.postMessage = postMessage;
    pp.endBrushGesture();
    return during;
  });
  expect(result.movements).toBeGreaterThanOrEqual(30);
  expect(result.workerJobs).toBeGreaterThanOrEqual(5);
  expect(result.elapsed).toBeGreaterThanOrEqual(1500);
  expect(result.interacting).toBe(true);
  expect(result.acceptedFrames, JSON.stringify(result)).toBeGreaterThanOrEqual(2);
});
