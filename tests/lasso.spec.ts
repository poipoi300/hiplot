import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loadDemo, pickColumn } from "./plot";

// Wide enough for every axis of the demo to be in view without scrolling.
test.use({ viewport: { width: 1900, height: 1000 } });

interface HiPlotWindow {
  hiplot_last_instance: {
    state: {
      rows_selected: { uid: string }[];
      rows_filtered: { uid: string }[];
    };
  };
}

const selectedUids = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as HiPlotWindow).hiplot_last_instance.state.rows_selected.map(
      (row) => row.uid,
    ),
  );
const filteredCount = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as HiPlotWindow).hiplot_last_instance.state.rows_filtered.length,
  );

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Element is not displayed");
  }
  return box;
}

/** Brushes the parallel plot's `dimension` axis between two fractions of its height. */
async function brushAxis(page: Page, dimension: string, from: number, to: number): Promise<void> {
  const overlay = await boxOf(
    page
      .locator("svg g.dimension")
      .filter({ has: page.locator(`.pplot-label[data-dimension='${dimension}']`) })
      .locator(".pplot-brush rect.overlay"),
  );
  const x = overlay.x + overlay.width / 2;
  await page.mouse.move(x, overlay.y + overlay.height * from);
  await page.mouse.down();
  await page.mouse.move(x, overlay.y + overlay.height * to, { steps: 6 });
  await page.mouse.up();
}

/**
 * Draws a lasso with Control held around the rectangle between two
 * fractions of `target`'s box, left/top to right/bottom.
 */
async function lasso(
  page: Page,
  target: Locator,
  [left, top]: [number, number],
  [right, bottom]: [number, number],
  modifier: "Control" | "Meta" = "Control",
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await boxOf(target);
  const at = (fx: number, fy: number) => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });
  const corners = [
    at(left, top),
    at(right, top),
    at(right, bottom),
    at(left, bottom),
    at(left, top),
  ];
  await page.keyboard.down(modifier);
  await page.mouse.move(corners[0].x, corners[0].y);
  await page.mouse.down();
  for (const corner of corners.slice(1)) {
    await page.mouse.move(corner.x, corner.y, { steps: 5 });
  }
  await page.mouse.up();
  await page.keyboard.up(modifier);
}

/** An XY scatter of two linear columns, whose ticks follow a zoom. */
async function openXY(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = page.getByTestId("scatter-panel").last();
  await pickColumn(panel, "X", "r");
  await pickColumn(panel, "Y", "pct_success");
  const svg = panel.getByRole("img", { name: /XY scatter plot/ });
  await expect(svg.locator(".tick text").first()).toBeAttached();
  await svg.scrollIntoViewIfNeeded();
  return svg;
}

test("a Ctrl-drag lassos the XY scatter, deselected points included; a drag still zooms", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "lr", 0.05, 0.2);
  const brushed = new Set(await selectedUids(page));
  const svg = await openXY(page);
  const ticks = () => svg.locator(".tick text").allTextContents();
  const unzoomed = await ticks();
  await lasso(page, svg, [0.15, 0.15], [0.85, 0.75]);
  await expect(page.getByTestId("lasso-selection")).toBeVisible();
  const lassoed = await selectedUids(page);
  expect(lassoed.length).toBeGreaterThan(0);
  expect(lassoed.some((uid) => !brushed.has(uid))).toBe(true);
  // The lasso did not zoom.
  expect(await ticks()).toEqual(unzoomed);
  await expect(page.getByTestId("scatter-panel").last().getByTestId("scatter-hint")).toHaveText(
    "Drag to zoom · Click to zoom out · Ctrl-drag to lasso",
  );

  const box = await boxOf(svg);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await expect.poll(ticks).not.toEqual(unzoomed);
  expect(await selectedUids(page)).toEqual(lassoed);
});

test("a lasso over a zoomed XY scatter takes only the points in view", async ({ page }) => {
  await loadDemo(page);
  const svg = await openXY(page);
  const box = await boxOf(svg);
  // Zooms into the left half of the plot.
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.8, { steps: 6 });
  await page.mouse.up();
  // A lasso around the whole panel, margins included.
  await lasso(page, svg, [0.01, 0.01], [0.99, 0.99]);
  const lassoed = await selectedUids(page);
  expect(lassoed.length).toBeGreaterThan(0);
  expect(lassoed.length).toBeLessThan(await filteredCount(page));
});

test("a Ctrl-drag over a one-axis plot lassos the values it spans, deselected rows included", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "lr", 0.05, 0.2);
  const brushed = new Set(await selectedUids(page));
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = page.getByTestId("scatter-panel").last();
  await pickColumn(panel, "Y", "pct_success");
  const plot = panel.locator('[data-testid="distribution-plot"][data-axis="pct_success"]');
  await expect(plot.locator("svg rect").first()).toBeAttached();
  await expect(panel.getByTestId("scatter-hint")).toHaveText(
    "Ctrl-drag across values to lasso them",
  );
  await lasso(page, plot.locator("svg").first(), [0.3, 0.2], [0.6, 0.7]);
  await expect(page.getByTestId("lasso-selection")).toBeVisible();
  const lassoed = new Set(await selectedUids(page));
  expect(lassoed.size).toBeGreaterThan(0);
  expect([...lassoed].some((uid) => !brushed.has(uid))).toBe(true);
  // The lasso spans one interval of values: every row inside it is taken.
  const { inside, outside } = await page.evaluate(
    (chosen) => {
      const rows = (
        window as unknown as {
          hiplot_last_instance: {
            state: { rows_filtered: { uid: string; pct_success: number }[] };
          };
        }
      ).hiplot_last_instance.state.rows_filtered;
      const taken = rows.filter((row) => chosen.includes(row.uid)).map((row) => row.pct_success);
      const [low, high] = [Math.min(...taken), Math.max(...taken)];
      return {
        inside: taken.length,
        outside: rows.filter(
          (row) => !chosen.includes(row.uid) && row.pct_success >= low && row.pct_success <= high,
        ).length,
      };
    },
    [...lassoed],
  );
  expect(inside).toBe(lassoed.size);
  expect(outside).toBe(0);
});

async function open3D(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = page.getByTestId("scatter-panel").last();
  await pickColumn(panel, "X", "lr");
  await pickColumn(panel, "Y", "exp_metric");
  await pickColumn(panel, "Z", "r");
  return panel.getByRole("img", { name: /3D scatter plot/ });
}

test("a lasso replaces the selection and the brushes, rows they left out included", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "lr", 0.05, 0.2);
  const brushed = new Set(await selectedUids(page));
  expect(brushed.size).toBeGreaterThan(0);
  expect(brushed.size).toBeLessThan(await filteredCount(page));

  const canvas = await open3D(page);
  await lasso(page, canvas, [0.25, 0.2], [0.75, 0.8]);
  const chip = page.getByTestId("lasso-selection");
  await expect(chip).toBeVisible();
  const lassoed = await selectedUids(page);
  expect(lassoed.length).toBeGreaterThan(0);
  // Rows the brush had deselected are lassoed too: the lasso is not one more filter.
  expect(lassoed.some((uid) => !brushed.has(uid))).toBe(true);
  await expect(chip).toHaveText(`Lasso selection · ${lassoed.length.toLocaleString("en-US")} rows`);
  await expect(page.getByTestId("selection-count").locator("strong")).toHaveText(
    lassoed.length.toLocaleString("en-US"),
  );
  // The brushes it replaced are gone, and so is their saved state.
  await expect(page.getByRole("button", { name: "Reset brushes" })).toBeDisabled();
  await expect(page.locator(".pplot-brush rect.selection")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("hip.PARALLEL_PLOT.brushes")).toBe("{}");

  // A new brush replaces the lasso's selection in turn.
  await page.evaluate(() => window.scrollTo(0, 0));
  await brushAxis(page, "lr", 0.05, 0.2);
  await expect(chip).toBeHidden();
  expect(new Set(await selectedUids(page))).toEqual(brushed);
});

test("a Cmd-drag lassos the 3D scatter as Ctrl does, and a plain drag still turns it", async ({
  page,
}) => {
  await loadDemo(page);
  const canvas = await open3D(page);
  const label = page.getByTestId("scatter-panel").last().locator("[data-axis-label='x-name']");
  const before = await label.getAttribute("style");
  await lasso(page, canvas, [0.3, 0.3], [0.7, 0.7], "Meta");
  await expect(page.getByTestId("lasso-selection")).toBeVisible();
  // Drawing the lasso did not turn the view.
  expect(await label.getAttribute("style")).toBe(before);

  const box = await boxOf(canvas);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => label.getAttribute("style")).not.toBe(before);
});

test("clearing a lasso selects every row again", async ({ page }) => {
  await loadDemo(page);
  const all = await filteredCount(page);
  await lasso(page, await open3D(page), [0.3, 0.3], [0.7, 0.7]);
  const chip = page.getByTestId("lasso-selection");
  await expect(chip).toBeVisible();
  expect((await selectedUids(page)).length).toBeLessThan(all);
  await chip.getByRole("button", { name: "Clear the lasso selection" }).click();
  await expect(chip).toBeHidden();
  expect((await selectedUids(page)).length).toBe(all);
});

/** The filters Keep and Exclude saved in the page state, which replay on reload. */
const savedFilters = (page: Page): unknown =>
  JSON.parse(new URL(page.url()).searchParams.get("hip.filters") ?? "null");

test("Keep and Exclude apply to a lasso's rows and are saved by uid", async ({ page }) => {
  await loadDemo(page);
  const all = await filteredCount(page);
  const canvas = await open3D(page);
  await lasso(page, canvas, [0.3, 0.3], [0.7, 0.7]);
  const excluded = await selectedUids(page);
  await page.getByRole("button", { name: "Exclude" }).click();
  await expect.poll(() => filteredCount(page)).toBe(all - excluded.length);
  await expect(page.getByTestId("lasso-selection")).toBeHidden();
  await expect
    .poll(() => savedFilters(page))
    .toEqual([{ type: "Not", data: { type: "Lasso", data: excluded } }]);

  await lasso(page, canvas, [0.2, 0.2], [0.8, 0.8]);
  const kept = await selectedUids(page);
  expect(kept.some((uid) => excluded.includes(uid))).toBe(false);
  await page.getByRole("button", { name: "Keep" }).click();
  await expect.poll(() => filteredCount(page)).toBe(kept.length);
  await expect
    .poll(() => savedFilters(page))
    .toEqual([
      { type: "Not", data: { type: "Lasso", data: excluded } },
      { type: "Lasso", data: kept },
    ]);
});
