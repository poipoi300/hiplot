import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { pickColumn } from "./plot";

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

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
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
