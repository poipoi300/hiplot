import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

const countText = (page: Page) => page.getByTestId("selection-count").textContent();

/** The HiPlot instance the standalone page exposes for debugging. */
interface HiPlotWindow {
  hiplot_last_instance: {
    state: { rows_selected: unknown[]; rows_highlighted: unknown[] };
  };
}

const rowCount = (page: Page, rows: "rows_selected" | "rows_highlighted"): Promise<number> =>
  page.evaluate(
    (key) => (window as unknown as HiPlotWindow).hiplot_last_instance.state[key].length,
    rows,
  );

const csv = (name: string, text: string) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});

test.describe("CSV upload", () => {
  test("an uploaded CSV file becomes the experiment", async ({ page }) => {
    await page.goto("/?provider=upload");
    await page
      .locator("input[type=file]")
      .setInputFiles(csv("runs.csv", "lr,loss\n0.1,0.5\n0.2,0.4\n0.3,0.45\n"));
    await expect(page.getByText("Loaded: runs.csv")).toBeVisible();
    await expect(page.getByTestId("selection-count")).toHaveText(/^3 of 3 selected/);
  });

  test("uploading several files at once is refused without loading any", async ({ page }) => {
    await page.goto("/?provider=upload");
    await page
      .locator("input[type=file]")
      .setInputFiles([csv("a.csv", "x\n1\n"), csv("b.csv", "x\n2\n")]);
    await expect(page.getByText("Uploading more than one file is not supported")).toBeVisible();
    await expect(page.getByText(/^Loaded:/)).toHaveCount(0);
  });

  test("a file that is not a CSV is refused", async ({ page }) => {
    await page.goto("/?provider=upload");
    await page.locator("input[type=file]").setInputFiles({
      name: "runs.json",
      mimeType: "application/json",
      buffer: Buffer.from("[]"),
    });
    await expect(
      page.getByText(/Unexpected file \(is it a CSV file\?\): runs\.json/),
    ).toBeVisible();
  });
});

const TUTORIAL_STEPS = 4;

test("the tutorial walks through every step and can be closed from the first", async ({ page }) => {
  await loadDemo(page);
  const help = page.getByRole("button", { name: "Help" });
  await help.click();
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toBeHidden();

  await help.click();
  const finish = page.getByRole("button", { name: "Finish" });
  for (let step = 1; step < TUTORIAL_STEPS; ++step) {
    await expect(finish).toBeHidden();
    await page.getByRole("button", { name: "Next" }).click();
  }
  await expect(finish).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await finish.click();
  await expect(finish).toBeHidden();
});

test("table search results can be selected", async ({ page }) => {
  await loadDemo(page);
  const before = await countText(page);
  const select = page.getByRole("button", { name: "Select results" });
  await expect(select).toBeHidden();
  await page.locator("input[type=search]").fill("adamw");
  await expect(select).toBeVisible();
  await select.click();
  await expect.poll(() => countText(page)).not.toBe(before);
  expect(await rowCount(page, "rows_selected")).toBeGreaterThan(0);
});

test.describe("XY plot", () => {
  const xyPlot = (page: Page) => page.getByRole("img", { name: "XY scatter plot" });
  const xTicks = (page: Page) =>
    xyPlot(page)
      .locator(".tick text")
      .evaluateAll((ticks) => ticks.map((tick) => tick.textContent));
  /** The X tick labels once two reads a quarter second apart agree. */
  const settledXTicks = async (page: Page): Promise<(string | null)[]> => {
    let previous = await xTicks(page);
    await expect
      .poll(
        async () => {
          const current = await xTicks(page);
          const settled = JSON.stringify(current) === JSON.stringify(previous);
          previous = current;
          return settled;
        },
        { intervals: [250] },
      )
      .toBe(true);
    return previous;
  };

  test("a parallel plot axis can be set as the X axis", async ({ page }) => {
    await loadDemo(page);
    await page.locator(".pplot-label[data-dimension='lr']").click({ button: "right" });
    await page.locator(".context-menu .dropdown-item", { hasText: "Set as X axis" }).click();
    await expect(page.locator(".plotxy-label").first()).toHaveText(/^lr(?!_)/);
    await page.locator(".plotxy-label").first().click({ button: "right" });
    await expect(
      page.locator(".context-menu .dropdown-item.disabled", { hasText: "Set as X axis" }),
    ).toBeVisible();
  });

  test("dragging a box zooms in and a click zooms back out", async ({ page }) => {
    await loadDemo(page);
    await xyPlot(page).scrollIntoViewIfNeeded();
    const box = await xyPlot(page).locator("g.brush rect.overlay").boundingBox();
    if (box === null) {
      throw new Error("No XY plot");
    }
    const initial = await settledXTicks(page);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => xTicks(page)).not.toEqual(initial);
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await expect.poll(() => xTicks(page)).toEqual(initial);
  });

  test("hovering names the closest point and the highlight mode can be changed", async ({
    page,
  }) => {
    await loadDemo(page);
    await xyPlot(page).scrollIntoViewIfNeeded();
    const box = await xyPlot(page).boundingBox();
    if (box === null) {
      throw new Error("No XY plot");
    }
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.5);
    await expect.poll(() => rowCount(page, "rows_highlighted")).toBeGreaterThan(0);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, { button: "right" });
    const option = page
      .locator(".context-menu .dropdown-item:not(.disabled)", { hasText: "Highlight:" })
      .first();
    const label = await option.textContent();
    if (label === null || label === "") {
      throw new Error("The highlight option has no label");
    }
    await option.click();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, { button: "right" });
    await expect(
      page.locator(".context-menu .dropdown-item.disabled", { hasText: label }),
    ).toBeVisible();
  });
});
