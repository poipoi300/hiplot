import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { scrollAxesToEnd } from "./plot";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/** Uploads a CSV of `columns` numeric columns with long names, 40 rows each. */
async function loadWideCsv(page: Page, columns: number): Promise<void> {
  const names = Array.from(
    { length: columns },
    (_, i) => `hyperparameter_${String(i).padStart(2, "0")}`,
  );
  const rows = Array.from({ length: 40 }, (_, row) =>
    names.map((_, column) => ((row * 7919 + column * 104729) % 1000) * 1.37e3).join(","),
  );
  await page.goto("/?provider=upload");
  await page.locator("input[type=file]").setInputFiles({
    name: "wide.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([names.join(","), ...rows].join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/** Left edge of each axis's tick labels and the axis position, left to right, in page pixels. */
async function axisExtents(page: Page): Promise<{ axis: number; labelsLeft: number }[]> {
  return page.locator("svg g.dimension").evaluateAll((groups) =>
    groups
      .map((group) => {
        const axisLine = group.querySelector(".domain");
        const ticks = Array.from(group.querySelectorAll(".tick text"));
        if (axisLine === null || ticks.length === 0) {
          throw new Error("An axis has no line or no tick labels");
        }
        return {
          axis: axisLine.getBoundingClientRect().left,
          labelsLeft: Math.min(...ticks.map((tick) => tick.getBoundingClientRect().left)),
        };
      })
      .sort((a, b) => a.axis - b.axis),
  );
}

test("many axes scroll sideways instead of crowding their tick labels", async ({ page }) => {
  await loadWideCsv(page, 40);
  const scroller = page.getByTestId("pplot-scroller");
  const overflow = await scroller.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeGreaterThan(0);
  const axes = await axisExtents(page);
  // The uploaded columns, plus the uid HiPlot adds.
  expect(axes).toHaveLength(41);
  for (let i = 1; i < axes.length; ++i) {
    // Each axis's labels stay clear of the previous axis and its brush band.
    expect(axes[i].labelsLeft - axes[i - 1].axis).toBeGreaterThan(15);
  }
});

test("scrolling brings the far axes into view, wheel gestures included", async ({ page }) => {
  await loadWideCsv(page, 40);
  const svg = await page.locator("svg[aria-label='Parallel coordinates axes']").boundingBox();
  if (svg === null) {
    throw new Error("No plot");
  }
  const rightmost = async () => Math.max(...(await axisExtents(page)).map((axis) => axis.axis));
  expect(await rightmost()).toBeGreaterThan(svg.x + svg.width);
  await scrollAxesToEnd(page);
  expect(await rightmost()).toBeLessThan(svg.x + svg.width);
  const before = (await axisExtents(page))[0].axis;
  await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await page.mouse.wheel(-300, 0);
  await expect.poll(async () => (await axisExtents(page))[0].axis).toBeGreaterThan(before);
});

test("the last axis title is never cut", async ({ page }) => {
  await loadWideCsv(page, 40);
  const titles = await page.locator("svg g.dimension .pplot-label").evaluateAll((labels) =>
    labels
      .map((label) => ({
        left: label.getBoundingClientRect().left,
        dimension: label.getAttribute("data-dimension"),
        text: label.firstChild?.textContent ?? "",
      }))
      .sort((a, b) => a.left - b.left),
  );
  const last = titles[titles.length - 1];
  expect(last.text).toBe(last.dimension);
  await scrollAxesToEnd(page);
  const svg = await page.locator("svg[aria-label='Parallel coordinates axes']").boundingBox();
  const title = await page
    .locator(`.pplot-label[data-dimension='${last.dimension}']`)
    .boundingBox();
  if (svg === null || title === null) {
    throw new Error("No plot or title");
  }
  expect(title.x + title.width).toBeLessThanOrEqual(svg.x + svg.width);
});

test.describe("column menu", () => {
  const axisNames = (page: Page) =>
    page
      .locator("svg g.dimension .pplot-label")
      .evaluateAll((labels) => labels.map((label) => label.getAttribute("data-dimension")));

  test("filtering then deselecting hides only the matching columns", async ({ page }) => {
    await loadDemo(page);
    const before = await axisNames(page);
    await page.getByTestId("columns-button").click();
    const menu = page.getByRole("dialog", { name: "Columns shown as axes" });
    await menu.getByRole("searchbox", { name: "Filter columns" }).fill("option");
    await expect(menu.getByRole("checkbox")).toHaveCount(2);
    await menu.getByRole("button", { name: "Deselect all", exact: true }).click();
    await expect.poll(() => axisNames(page)).toHaveLength(before.length - 2);
    expect(await axisNames(page)).not.toContain("optionA");
    await menu.getByRole("button", { name: "Select all", exact: true }).click();
    await expect.poll(() => axisNames(page)).toHaveLength(before.length);
  });

  test("a checkbox toggles one column and the badge counts the shown ones", async ({ page }) => {
    await loadDemo(page);
    const button = page.getByTestId("columns-button");
    const total = (await axisNames(page)).length;
    await expect(button).toContainText(`${total}/`);
    await button.click();
    const menu = page.getByRole("dialog", { name: "Columns shown as axes" });
    await menu.getByRole("checkbox", { name: "seed" }).uncheck();
    await expect.poll(() => axisNames(page)).not.toContain("seed");
    await expect(button).toContainText(`${total - 1}/`);
    await menu.getByRole("checkbox", { name: "seed" }).check();
    await expect.poll(() => axisNames(page)).toContain("seed");
  });

  test("Escape closes the menu and returns focus to its button", async ({ page }) => {
    await loadDemo(page);
    await page.getByTestId("columns-button").click();
    const menu = page.getByRole("dialog", { name: "Columns shown as axes" });
    await expect(menu.getByRole("searchbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("columns-button")).toBeFocused();
  });

  test("a press outside the menu closes it", async ({ page }) => {
    await loadDemo(page);
    await page.getByTestId("columns-button").click();
    const menu = page.getByRole("dialog", { name: "Columns shown as axes" });
    await menu.getByRole("searchbox").fill("no such column");
    await expect(menu).toContainText("No column matches");
    await page.mouse.click(5, 5);
    await expect(menu).toBeHidden();
  });
});

test("brush tags sit centered on the axis at the top and bottom edges", async ({ page }) => {
  await loadDemo(page);
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").nth(3);
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
  const dimension = page.locator("svg g.dimension").nth(3);
  const band = await dimension.locator(".pplot-brush rect.selection").boundingBox();
  const axis = await dimension.locator(".domain").boundingBox();
  const top = await dimension.locator("[data-edge='top'] rect").boundingBox();
  const bottom = await dimension.locator("[data-edge='bottom'] rect").boundingBox();
  if (band === null || axis === null || top === null || bottom === null) {
    throw new Error("Missing brush, axis or tag");
  }
  expect(top.y + top.height).toBeLessThanOrEqual(band.y);
  expect(bottom.y).toBeGreaterThanOrEqual(band.y + band.height);
  for (const tag of [top, bottom]) {
    expect(Math.abs(tag.x + tag.width / 2 - (axis.x + axis.width / 2))).toBeLessThan(1.5);
  }
});

test("a brush between two categories is tagged as selecting none", async ({ page }) => {
  await loadDemo(page);
  const dimension = page
    .locator("svg g.dimension")
    .filter({ has: page.locator(".pplot-label[data-dimension='c']") });
  const overlay = dimension.locator(".pplot-brush rect.overlay");
  await scrollAxesToEnd(page);
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.38, { steps: 6 });
  await page.mouse.up();
  // One tag: both ends name the same (lack of a) category.
  await expect(dimension.locator("text.pplot-brush-range")).toHaveText(["none"]);
  await expect(page.getByTestId("selection-count")).toHaveText(/^0 of/);
});
