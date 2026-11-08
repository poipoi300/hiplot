import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Wide enough for every axis of the demo to be in view without scrolling.
test.use({ viewport: { width: 1900, height: 1000 } });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HiPlotWindow {
  hiplot_last_instance: { state: { rows_filtered: Record<string, unknown>[] } };
}

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

const axis = (page: Page, dimension: string): Locator =>
  page
    .locator("svg g.dimension")
    .filter({ has: page.locator(`.pplot-label[data-dimension='${dimension}']`) });
const bands = (page: Page, dimension: string): Locator =>
  axis(page, dimension).locator(".pplot-brush rect.selection");

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Element is not displayed");
  }
  return box;
}

async function drag(page: Page, x: number, from: number, to: number): Promise<void> {
  await page.mouse.move(x, from);
  await page.mouse.down();
  await page.mouse.move(x, to, { steps: 6 });
  await page.mouse.up();
}

/** Drags along an axis between two fractions of its height, from the top. */
async function brushAxis(page: Page, dimension: string, from: number, to: number): Promise<void> {
  const overlay = await boxOf(axis(page, dimension).locator(".pplot-brush rect.overlay"));
  const x = overlay.x + overlay.width / 2;
  await drag(page, x, overlay.y + overlay.height * from, overlay.y + overlay.height * to);
}

async function counts(page: Page): Promise<{ selected: number; total: number }> {
  const text = ((await page.getByTestId("selection-count").textContent()) ?? "").replace(/,/g, "");
  const match = text.match(/(\d+)\s*of\s*(\d+)/);
  if (match === null) {
    throw new Error(`Unreadable selection count "${text}"`);
  }
  return { selected: Number(match[1]), total: Number(match[2]) };
}
const selected = async (page: Page): Promise<number> => (await counts(page)).selected;

/** Brushes one range alone, reads its count, and removes the brush again by clicking it. */
async function countOfLoneBrush(
  page: Page,
  dimension: string,
  from: number,
  to: number,
): Promise<number> {
  const total = (await counts(page)).total;
  await brushAxis(page, dimension, from, to);
  await expect(bands(page, dimension)).toHaveCount(1);
  await expect.poll(() => selected(page)).toBeLessThan(total);
  const count = await selected(page);
  const band = await boxOf(bands(page, dimension));
  await page.mouse.click(band.x + band.width / 2, band.y + band.height / 2);
  await expect(bands(page, dimension)).toHaveCount(0);
  await expect.poll(() => selected(page)).toBe(total);
  return count;
}

const overlaps = (a: Box, b: Box): boolean => a.y < b.y + b.height && b.y < a.y + a.height;

test("brushes on one axis select the rows in any of them", async ({ page }) => {
  await loadDemo(page);
  const ranges: [number, number][] = [
    [0.05, 0.2],
    [0.4, 0.55],
    [0.75, 0.9],
  ];
  const alone: number[] = [];
  for (const [from, to] of ranges) {
    alone.push(await countOfLoneBrush(page, "seed", from, to));
  }
  for (const [from, to] of ranges) {
    await brushAxis(page, "seed", from, to);
  }
  await expect(bands(page, "seed")).toHaveCount(3);
  await expect(axis(page, "seed").locator("text.pplot-brush-range")).toHaveCount(6);
  // Disjoint brushes: the rows in any of them are the sum of the rows in each.
  await expect.poll(() => selected(page)).toBe(alone[0] + alone[1] + alone[2]);
  await expect(page.getByRole("button", { name: "Reset brushes" })).toBeEnabled();
});

test("categorical brushes select the categories inside any of them", async ({ page }) => {
  await loadDemo(page);
  // Categories go black, green, red from the bottom: brush the two ends.
  await brushAxis(page, "c", 0, 0.15);
  await brushAxis(page, "c", 0.85, 1);
  await expect(bands(page, "c")).toHaveCount(2);
  const expected = await page.evaluate(
    () =>
      (window as unknown as HiPlotWindow).hiplot_last_instance.state.rows_filtered.filter(
        (row) => row.c === "red" || row.c === "black",
      ).length,
  );
  await expect.poll(() => selected(page)).toBe(expected);
  // Each brush covers a single category, so it takes a single tag.
  const texts = await axis(page, "c").locator("text.pplot-brush-range").allTextContents();
  expect(texts.sort()).toEqual(["black", "red"]);
});

test("a categorical brush tags its highest category on top and its lowest below", async ({
  page,
}) => {
  await loadDemo(page);
  // Red is drawn at the top of the axis and green in the middle.
  await brushAxis(page, "c", 0, 0.6);
  const tags = axis(page, "c");
  await expect(tags.locator("[data-edge='top'] text.pplot-brush-range")).toHaveText("red");
  await expect(tags.locator("[data-edge='bottom'] text.pplot-brush-range")).toHaveText("green");
});

test("the brush under the pointer is highlighted and the other tags of its axis dimmed", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await brushAxis(page, "seed", 0.6, 0.8);
  await page.mouse.move(5, 5);
  const tags = axis(page, "seed").locator("[data-edge]:has(text.pplot-brush-range)");
  await expect(tags).toHaveCount(4);
  const styles = () =>
    tags.evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.querySelector("rect");
          return `${getComputedStyle(element).opacity}:${rect === null ? "" : getComputedStyle(rect).fill}`;
        })
        .sort(),
    );
  const resting = await styles();
  expect(new Set(resting).size).toBe(1);
  const upper = await boxOf(bands(page, "seed").first());
  await page.mouse.move(upper.x + upper.width / 2, upper.y + upper.height / 2);
  await expect
    .poll(async () => (await styles()).map((style) => style.split(":")[0]))
    .toEqual(["0.3", "0.3", "1", "1"]);
  const highlighted = (await styles()).filter((style) => style.startsWith("1:"));
  expect(highlighted.every((style) => style !== resting[0])).toBe(true);
  await page.mouse.move(5, 5);
  await expect.poll(styles).toEqual(resting);
});

test("a brush moves by its body, resizes by its edge, and merges with one it touches", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.25);
  await brushAxis(page, "seed", 0.5, 0.6);
  await expect(bands(page, "seed")).toHaveCount(2);
  const before = await selected(page);

  const lower = await boxOf(bands(page, "seed").nth(1));
  const x = lower.x + lower.width / 2;
  await drag(page, x, lower.y + lower.height / 2, lower.y + lower.height / 2 + 30);
  const moved = await boxOf(bands(page, "seed").nth(1));
  expect(moved.y).toBeCloseTo(lower.y + 30, 0);
  expect(moved.height).toBeCloseTo(lower.height, 0);

  await drag(page, x, moved.y + moved.height, moved.y + moved.height + 25);
  const resized = await boxOf(bands(page, "seed").nth(1));
  expect(resized.y).toBeCloseTo(moved.y, 0);
  expect(resized.height).toBeCloseTo(moved.height + 25, 0);
  await expect.poll(() => selected(page)).not.toBe(before);

  // Drag the lower brush's top edge over the upper brush: they merge into one on release.
  const upper = await boxOf(bands(page, "seed").first());
  await drag(page, x, resized.y, upper.y + upper.height / 2);
  await expect(bands(page, "seed")).toHaveCount(1);
  const merged = await boxOf(bands(page, "seed"));
  expect(merged.y).toBeCloseTo(upper.y, 0);
  expect(merged.y + merged.height).toBeCloseTo(resized.y + resized.height, 0);
  await expect(axis(page, "seed").locator("text.pplot-brush-range")).toHaveCount(2);
});

test("tags bump inside brushes that leave no room outside, and never overlap", async ({ page }) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.005, 0.2);
  await brushAxis(page, "seed", 0.25, 0.4);
  await brushAxis(page, "seed", 0.7, 0.85);
  await expect(bands(page, "seed")).toHaveCount(3);
  const tags = axis(page, "seed").locator("[data-edge]:has(text.pplot-brush-range)");
  await expect(tags).toHaveCount(6);
  const placed = await tags.evaluateAll((elements) =>
    elements.map((element) => ({
      edge: element.getAttribute("data-edge"),
      inside: element.getAttribute("data-inside"),
      top: element.getBoundingClientRect().top,
    })),
  );
  placed.sort((a, b) => a.top - b.top);
  // From the top: the axis end and the close neighbors put three tags inside.
  expect(placed.map((tag) => `${tag.edge}:${tag.inside}`)).toEqual([
    "top:true",
    "bottom:true",
    "top:true",
    "bottom:false",
    "top:false",
    "bottom:false",
  ]);

  const tagBoxes = await Promise.all((await tags.locator("rect").all()).map((rect) => boxOf(rect)));
  for (let i = 0; i < tagBoxes.length; ++i) {
    for (let j = i + 1; j < tagBoxes.length; ++j) {
      expect(overlaps(tagBoxes[i], tagBoxes[j])).toBe(false);
    }
  }
  const first = await boxOf(bands(page, "seed").first());
  const insideTop = await boxOf(axis(page, "seed").locator("[data-inside='true'] rect").first());
  expect(insideTop.y).toBeGreaterThanOrEqual(first.y);
  expect(insideTop.y + insideTop.height).toBeLessThanOrEqual(first.y + first.height);
});

test("clicking an axis outside its brushes removes all of them, and only them", async ({
  page,
}) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await brushAxis(page, "seed", 0.5, 0.6);
  await brushAxis(page, "r", 0.2, 0.9);
  const brushedR = await selected(page);
  const overlay = await boxOf(axis(page, "seed").locator(".pplot-brush rect.overlay"));
  // Off the axis line, at the band's edge: anywhere on the axis counts.
  await page.mouse.click(overlay.x + 3, overlay.y + overlay.height * 0.8);
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect(bands(page, "r")).toHaveCount(1);
  await expect.poll(() => selected(page)).toBeGreaterThanOrEqual(brushedR);
  // A click on an axis without brushes changes nothing.
  await page.mouse.click(overlay.x + overlay.width / 2, overlay.y + overlay.height * 0.4);
  await expect(bands(page, "r")).toHaveCount(1);
});

test("clicking a brush removes just that brush", async ({ page }) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await brushAxis(page, "seed", 0.5, 0.6);
  const upper = await boxOf(bands(page, "seed").first());
  const lower = await boxOf(bands(page, "seed").nth(1));
  await page.mouse.click(upper.x + upper.width / 2, upper.y + upper.height / 2);
  await expect(bands(page, "seed")).toHaveCount(1);
  const left = await boxOf(bands(page, "seed"));
  expect(Math.abs(left.y - lower.y)).toBeLessThanOrEqual(1);
});

test("the axis menu clears the brushes of that axis only", async ({ page }) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await brushAxis(page, "seed", 0.6, 0.8);
  await brushAxis(page, "r", 0.2, 0.9);
  await page.locator(".pplot-label[data-dimension='seed']").click({ button: "right" });
  await page
    .locator(".context-menu .dropdown-item", { hasText: "Clear brushes on this axis" })
    .click();
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect(bands(page, "r")).toHaveCount(1);
  await page.locator(".pplot-label[data-dimension='seed']").click({ button: "right" });
  await expect(page.locator(".context-menu.show")).toBeVisible();
  await expect(
    page.locator(".context-menu .dropdown-item", { hasText: "Clear brushes on this axis" }),
  ).toHaveCount(0);
});

test("brushes are restored after a reload", async ({ page }) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await brushAxis(page, "seed", 0.6, 0.8);
  await expect(bands(page, "seed")).toHaveCount(2);
  const before = await Promise.all([0, 1].map((index) => boxOf(bands(page, "seed").nth(index))));
  // Saved as the values they select, not as positions on the axis.
  await expect.poll(() => decodeURIComponent(page.url())).toContain('"seed":[{"min":');
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(bands(page, "seed")).toHaveCount(2);
  for (const [index, box] of before.entries()) {
    const after = await boxOf(bands(page, "seed").nth(index));
    // Within a pixel: the bands snap to whole pixels.
    expect(Math.abs(after.y - box.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - box.height)).toBeLessThanOrEqual(1);
  }
  await expect(page.getByRole("button", { name: "Reset brushes" })).toBeEnabled();
  const { selected: count, total } = await counts(page);
  expect(count).toBeLessThan(total);
});

test("a brush that selects nothing is restored in place after a reload, still selecting nothing", async ({
  page,
}) => {
  await loadDemo(page);
  // Between red at the top and green in the middle: no category.
  await brushAxis(page, "c", 0.2, 0.3);
  await expect(bands(page, "c")).toHaveCount(1);
  await expect.poll(() => selected(page)).toBe(0);
  const before = await boxOf(bands(page, "c"));
  await expect.poll(() => page.url()).toContain("brushes");
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(bands(page, "c")).toHaveCount(1);
  const after = await boxOf(bands(page, "c"));
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  await expect.poll(() => selected(page)).toBe(0);
});

/** Reloads the demo with `saved` as the saved brushes. */
async function loadSavedBrushes(page: Page, saved: Record<string, unknown[]>): Promise<void> {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.1, 0.3);
  await expect.poll(() => page.url()).toContain("brushes");
  const url = new URL(page.url());
  const key = [...url.searchParams.keys()].find((name) => name.endsWith("brushes"));
  if (key === undefined) {
    throw new Error("No saved brushes in the URL");
  }
  url.searchParams.set(key, JSON.stringify(saved));
  await page.goto(url.toString());
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

test("brushes saved as axis positions by earlier versions still load", async ({ page }) => {
  // From the bottom of the axis: 20 % to 40 % of its height.
  await loadSavedBrushes(page, { seed: [[0.2, 0.4]] });
  await expect(bands(page, "seed")).toHaveCount(1);
  const overlay = await boxOf(axis(page, "seed").locator(".pplot-brush rect.overlay"));
  const band = await boxOf(bands(page, "seed"));
  expect(Math.abs(band.y - (overlay.y + overlay.height * 0.6))).toBeLessThanOrEqual(1);
  expect(Math.abs(band.height - overlay.height * 0.2)).toBeLessThanOrEqual(1);
});

test("a brush resized over a whole axis filters nothing and is removed on release", async ({
  page,
}) => {
  await loadDemo(page);
  const total = (await counts(page)).total;
  await brushAxis(page, "seed", 0.5, 1.2);
  const overlay = await boxOf(axis(page, "seed").locator(".pplot-brush rect.overlay"));
  const band = await boxOf(bands(page, "seed"));
  const x = band.x + band.width / 2;
  await page.mouse.move(x, band.y);
  await page.mouse.down();
  await page.mouse.move(x, overlay.y - 40, { steps: 8 });
  // While the pointer is down the brush is drawn, over the whole axis.
  // Its box takes in half the stroke.
  await expect
    .poll(async () => (await boxOf(bands(page, "seed"))).y)
    .toBeLessThanOrEqual(overlay.y + 0.5);
  await page.mouse.up();
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect.poll(() => selected(page)).toBe(total);
  await expect(page.getByRole("button", { name: "Reset brushes" })).toBeDisabled();
});

test("brushes that merge into the whole axis are removed", async ({ page }) => {
  await loadDemo(page);
  const total = (await counts(page)).total;
  await brushAxis(page, "seed", 0.6, 1.2);
  await brushAxis(page, "seed", 0.4, -0.2);
  await expect(bands(page, "seed")).toHaveCount(2);
  // Drag the upper brush's bottom edge into the lower brush.
  const upper = await boxOf(bands(page, "seed").first());
  const lower = await boxOf(bands(page, "seed").nth(1));
  await drag(page, upper.x + upper.width / 2, upper.y + upper.height, lower.y + 20);
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect.poll(() => selected(page)).toBe(total);
});

test("saved brushes covering a whole axis are not restored", async ({ page }) => {
  await loadSavedBrushes(page, {
    seed: [[0, 1]],
    c: [{ categories: ["black", "green", "red"] }],
    r: [{ min: 0.3, max: 0.5, include_infnans: false }],
  });
  await expect(bands(page, "r")).toHaveCount(1);
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect(bands(page, "c")).toHaveCount(0);
});

test("Keep saves the brushes of an axis as one multi-range filter", async ({ page }) => {
  await loadDemo(page);
  await brushAxis(page, "seed", 0.05, 0.25);
  await brushAxis(page, "seed", 0.6, 0.8);
  await expect.poll(async () => (await counts(page)).selected).toBeGreaterThan(0);
  const kept = await selected(page);
  await page.getByRole("button", { name: "Keep" }).click();
  await expect.poll(() => counts(page)).toEqual({ selected: kept, total: kept });
  await expect(bands(page, "seed")).toHaveCount(0);
  await expect.poll(() => decodeURIComponent(page.url())).toContain('"type":"Any"');
});
