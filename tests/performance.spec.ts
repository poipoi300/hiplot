import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { warmParallelWorker } from "./plot";

interface DrawnFrame {
  draft: boolean;
  resolution: number;
  drawnRows: number;
}
interface QualityProbe {
  linesBusy: boolean;
  draftFrame: () => boolean;
  geometry: () => { rows: readonly unknown[] };
  lineFrame: (
    geometry: unknown,
    mask: Uint8Array,
  ) => DrawnFrame & { selectedCount: number; contextCount: number };
  drawWithWebGL: (renderer: QualityProbe["webgl"]) => void;
  recordFrame: (frame: { milliseconds: number; fullQuality: boolean }) => void;
  webgl: {
    draw: (frame: DrawnFrame) => void;
    drawCooperative: (frame: DrawnFrame, isCurrent?: () => boolean) => Promise<void>;
    present: (pixels: Uint8ClampedArray, width: number, height: number) => void;
    finishedFrame: () => { milliseconds: number; fullQuality: boolean } | null;
    busy: boolean;
    rowCount: number;
  };
  continuous: {
    busy: boolean;
    draw: (
      frame: DrawnFrame & { selectedCount: number; contextCount: number },
      colors: unknown,
      mask: Uint8Array,
    ) => void;
  } | null;
  continuousFrame: number;
  continuousMode: () => boolean;
  interacting: boolean;
  scrollLeft: number;
  redrawLines: () => void;
  state: { slowFrames: boolean; renderQuality: string };
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => QualityProbe | null };
  __frames?: DrawnFrame[];
  __presentations?: number;
  __continuousRows?: number[];
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
  const before = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp?.continuous) return null;
    const before = pp.continuousFrame;
    pp.redrawLines();
    return before;
  });
  if (before !== null) await waitForContinuous(page, before);
  await page.evaluate(() => {
    const win = window as unknown as HiPlotWindow;
    const pp = win.hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    win.__frames = [];
    win.__presentations = 0;
    win.__continuousRows = [];
    const lineFrame = pp.lineFrame.bind(pp);
    pp.lineFrame = (geometry, mask) => {
      const frame = lineFrame(geometry, mask);
      if (pp.continuousMode()) {
        win.__continuousRows?.push(
          frame.drawnRows,
          mask.length,
          frame.selectedCount + frame.contextCount,
        );
      }
      return frame;
    };
    const draw = pp.drawWithWebGL.bind(pp);
    pp.drawWithWebGL = (renderer) => {
      win.__frames?.push({
        draft: pp.draftFrame(),
        resolution: 1,
        drawnRows: pp.geometry().rows.length,
      });
      draw(renderer);
    };
    const present = pp.webgl.present.bind(pp.webgl);
    pp.webgl.present = (...args) => {
      win.__presentations = (win.__presentations ?? 0) + 1;
      present(...args);
    };
  });
}

async function waitForContinuous(page: Page, after = 0): Promise<void> {
  await page.waitForFunction((after) => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    return (
      pp?.continuousMode() && pp.continuousFrame > after && !pp.continuous?.busy && !pp.webgl.busy
    );
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
  await expect(page.getByRole("radio", { name: "Continuous density", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Exact lines", exact: true })).toBeVisible();
});

test("forced continuous density counts every row at rest, while brushing and after release", async ({
  page,
}) => {
  await upload(page, 12_000, `&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`);
  await waitForContinuous(page);
  await expect(qualityButton(page)).toHaveText("Continuous density");
  await recordFrames(page);
  const initial = await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) throw new Error("No parallel plot");
    const initial = pp.continuousFrame;
    pp.redrawLines();
    return initial;
  });
  await waitForContinuous(page, initial);
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
    return {
      frame: pp.continuousFrame,
      continuous: pp.continuousMode(),
      interacting: pp.interacting,
    };
  });
  expect(during.continuous).toBe(true);
  expect(during.interacting).toBe(true);
  await page.mouse.up();
  await waitForContinuous(page, during.frame);
  await expect(qualityButton(page)).toHaveText("Continuous density");
  expect(await frames(page)).toEqual([]);
  const counts = await page.evaluate(
    () => (window as unknown as HiPlotWindow).__continuousRows ?? [],
  );
  expect(counts.length).toBeGreaterThan(6);
  expect(counts.every((count) => count === 12_000)).toBe(true);
});

test("automatic software mode bins before drawing more than 6000 original rows", async ({
  page,
}) => {
  await upload(page, 6001);
  await waitForContinuous(page);
  await expect(qualityButton(page)).toHaveText("Continuous density");
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
    const recordFrame = pp.recordFrame.bind(pp);
    pp.recordFrame = () => recordFrame({ milliseconds: 200, fullQuality: true });
    for (let i = 0; i < 5; ++i) {
      pp.redrawLines();
      do {
        await new Promise(requestAnimationFrame);
      } while (pp.linesBusy);
    }
  });
  await waitForContinuous(page);
  await expect(qualityButton(page)).toHaveText("Continuous density");
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
      return pp?.continuous === null && pp.state.slowFrames;
    }),
  ).toBe(true);
});

test("scrolling and its settle redraw remain continuous without sampling or exact-row draws", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
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
  await waitForContinuous(page);
  await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
  await waitForContinuous(page);
  await recordFrames(page);
  const initial = await page.evaluate(
    () =>
      (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot()?.continuousFrame ??
      0,
  );
  await page.getByTestId("pplot-scroller").evaluate((scroller) => {
    scroller.scrollLeft = 300;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot()?.scrollLeft,
      ),
    )
    .toBe(300);
  // A slow worker may coalesce scroll and settle jobs. Finish the scroll image
  // before advancing the settle timer so both rendering paths are exercised.
  await page.clock.runFor(16);
  await waitForContinuous(page, initial);
  const scrolling = await page.evaluate(
    () =>
      (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot()?.continuousFrame ??
      0,
  );
  await page.clock.runFor(150);
  await waitForContinuous(page, scrolling);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as HiPlotWindow).__presentations ?? 0))
    .toBeGreaterThanOrEqual(2);
  await expect(qualityButton(page)).toHaveText("Continuous density");
  expect(await frames(page)).toEqual([]);
  const counts = await page.evaluate(
    () => (window as unknown as HiPlotWindow).__continuousRows ?? [],
  );
  expect(counts.length).toBeGreaterThanOrEqual(6);
  expect(counts.every((count) => count === 50)).toBe(true);
});

test("continuous brushing presents density while worker jobs are slower than input", async ({
  page,
}) => {
  await upload(page, 12_000, `&hip.PARALLEL_PLOT.renderQuality=${encodeURIComponent('"low"')}`);
  await waitForContinuous(page);
  await recordFrames(page);
  await warmParallelWorker(page);
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
    if (!pp || pp.continuous === null) throw new Error("No continuous parallel plot");
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
    const initialFrame = pp.continuousFrame;
    const drafts: boolean[] = [];
    const draw = pp.continuous.draw.bind(pp.continuous);
    pp.continuous.draw = (frame, colors, mask) => {
      drafts.push(frame.draft);
      draw(frame, colors, mask);
    };
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
      acceptedFrames: pp.continuousFrame - initialFrame,
      movements,
      workerJobs,
      drafts,
      elapsed: performance.now() - started,
      interacting: pp.interacting,
    };
    Worker.prototype.postMessage = postMessage;
    pp.continuous.draw = draw;
    pp.endBrushGesture();
    return during;
  });
  expect(result.movements, JSON.stringify(result)).toBeGreaterThanOrEqual(30);
  expect(result.workerJobs, JSON.stringify(result)).toBeGreaterThanOrEqual(5);
  expect(result.elapsed).toBeGreaterThanOrEqual(1500);
  expect(result.interacting).toBe(true);
  expect(result.drafts.length).toBeGreaterThanOrEqual(2);
  expect(result.drafts.every(Boolean), JSON.stringify(result)).toBe(true);
  expect(result.acceptedFrames, JSON.stringify(result)).toBeGreaterThanOrEqual(2);
});
