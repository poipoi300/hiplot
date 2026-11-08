import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("table.sample-rows-table tbody tr", { timeout: 15000 });
}

const header = (page: Page, column: string) =>
  page
    .locator("table.sample-rows-table thead tr:first-child th")
    .filter({ has: page.locator(".dt-column-title", { hasText: new RegExp(`^${column}$`) }) });

const info = (page: Page) => page.locator(".dt-info").textContent();

/** A column's filter input, opening it from its button when it is not in use yet. */
async function columnFilter(page: Page, column: string) {
  const button = page.getByRole("button", { name: `Filter ${column}`, exact: true });
  if ((await button.count()) > 0) {
    await button.click();
  }
  return page.getByRole("textbox", { name: `Filter ${column}` });
}

test("sort indicators sit right of the title on text and numeric columns", async ({ page }) => {
  await loadDemo(page);
  for (const column of ["optimizer", "exp_metric"]) {
    const title = await header(page, column).locator(".dt-column-title").boundingBox();
    const indicator = await header(page, column).locator(".dt-column-order").boundingBox();
    if (title === null || indicator === null) {
      throw new Error(`No title or indicator for ${column}`);
    }
    expect(indicator.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
  }
});

test("shift-click adds a secondary sort and numbers the priorities", async ({ page }) => {
  await loadDemo(page);
  await header(page, "optimizer").locator(".dt-column-title").click();
  await expect(page.locator(".dt-column-order[data-priority]")).toHaveCount(0);
  await header(page, "exp_metric")
    .locator(".dt-column-title")
    .click({ modifiers: ["Shift"] });
  await expect(header(page, "optimizer").locator(".dt-column-order")).toHaveAttribute(
    "data-priority",
    "1",
  );
  await expect(header(page, "exp_metric").locator(".dt-column-order")).toHaveAttribute(
    "data-priority",
    "2",
  );
  const order = await page.evaluate(() => {
    const table = (
      window as unknown as {
        hiplot_last_instance: {
          plugins_ref: { TABLE: { current: { dt: { order(): unknown[] } } } };
        };
      }
    ).hiplot_last_instance.plugins_ref.TABLE.current;
    return table.dt.order().length;
  });
  expect(order).toBe(2);
});

test("column filters combine and their rows can be selected", async ({ page }) => {
  await loadDemo(page);
  const all = await info(page);
  await (await columnFilter(page, "optimizer")).fill("adam");
  await expect.poll(() => info(page)).not.toBe(all);
  const adam = await info(page);
  await (await columnFilter(page, "exp_metric")).fill("<0.01");
  await expect.poll(() => info(page)).not.toBe(adam);
  const select = page.getByRole("button", { name: "Select results" });
  await expect(select).toBeVisible();
  const shown = Number((await info(page))?.match(/of ([\d,]+) rows/)?.[1].replace(",", ""));
  await select.click();
  await expect(page.getByTestId("selection-count")).toHaveText(
    new RegExp(`^${shown.toLocaleString("en-US")} of`),
  );
  await (await columnFilter(page, "exp_metric")).fill("");
  await (await columnFilter(page, "optimizer")).fill("");
  await expect(select).toBeHidden();
});

test("typing in a column filter does not sort the column", async ({ page }) => {
  await loadDemo(page);
  const filter = await columnFilter(page, "exp_metric");
  await expect(filter).toBeFocused();
  await filter.press("Enter");
  await expect(header(page, "exp_metric")).not.toHaveClass(/dt-ordering-/);
});

test("numbers show six significant digits with the exact value in a tooltip", async ({ page }) => {
  await loadDemo(page);
  const cell = page.locator("table.sample-rows-table tbody td span[title]").first();
  const exact = Number(await cell.getAttribute("title"));
  const shown = Number(await cell.textContent());
  expect(Number.isFinite(shown)).toBe(true);
  expect(Math.abs(shown - exact)).toBeLessThanOrEqual(Math.abs(exact) * 1e-5);
});
