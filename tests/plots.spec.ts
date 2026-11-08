import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

const scatterPanels = (page: Page) => page.getByTestId("scatter-panel");
const select = (page: Page, axis: string) =>
  scatterPanels(page).last().getByLabel(axis, { exact: true });

async function reloadDemo(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

test("a scatter plot grows from a distribution to an XY then a 3D scatter, and is kept", async ({
  page,
}) => {
  await loadDemo(page);
  const before = await scatterPanels(page).count();
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await expect(scatterPanels(page)).toHaveCount(before + 1);
  const panel = scatterPanels(page).last();
  await expect(panel).toContainText("Pick X to see its distribution");

  await select(page, "X").selectOption("lr");
  await expect(panel.locator("svg").first()).toBeVisible();
  await expect(panel).toContainText("Distribution of X");

  await select(page, "Y").selectOption("exp_metric");
  await expect(panel.getByRole("img", { name: "XY scatter plot" })).toBeVisible();

  await select(page, "Z").selectOption("r");
  const scatter3d = panel.getByRole("img", { name: /3D scatter plot/ });
  await expect(scatter3d).toBeVisible();
  await expect(panel.locator("[data-axis-label='z-name']")).toHaveText("r");

  await reloadDemo(page);
  await expect(scatterPanels(page)).toHaveCount(before + 1);
  await expect(select(page, "Z")).toHaveValue("r");
});

test("the 3D scatter turns when dragged and names the point under the pointer", async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await select(page, "X").selectOption("lr");
  await select(page, "Y").selectOption("exp_metric");
  await select(page, "Z").selectOption("r");
  const canvas = scatterPanels(page)
    .last()
    .getByRole("img", { name: /3D scatter plot/ });
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("No 3D scatter");
  }
  const label = scatterPanels(page).last().locator("[data-axis-label='x-name']");
  const before = await label.getAttribute("style");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => label.getAttribute("style")).not.toBe(before);

  const tooltip = page.getByTestId("scatter3d-tooltip");
  for (let step = 0; step < 60 && !(await tooltip.isVisible()); ++step) {
    await page.mouse.move(
      box.x + box.width * (0.35 + 0.3 * ((step % 10) / 10)),
      box.y + box.height * (0.3 + 0.4 * (Math.floor(step / 10) / 6)),
    );
    await page.waitForTimeout(20);
  }
  await expect(tooltip).toBeVisible();
});

test("closing a scatter plot removes it for good", async ({ page }) => {
  await loadDemo(page);
  const count = await scatterPanels(page).count();
  expect(count).toBeGreaterThan(0);
  await scatterPanels(page).first().getByRole("button", { name: "Close scatter plot" }).click();
  await expect(scatterPanels(page)).toHaveCount(count - 1);
  await reloadDemo(page);
  await expect(scatterPanels(page)).toHaveCount(count - 1);
});

test("there is no separate distributions section; the axis menu opens a one-axis plot", async ({
  page,
}) => {
  await loadDemo(page);
  await expect(page.getByTestId("distribution-plots")).toHaveCount(0);
  const before = await scatterPanels(page).count();
  await page.locator(".pplot-label[data-dimension='optimizer']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  await expect(scatterPanels(page)).toHaveCount(before + 1);
  await expect(select(page, "X")).toHaveValue("optimizer");
  await expect(
    page.locator('[data-testid="distribution-plot"][data-axis="optimizer"]'),
  ).toBeVisible();
  // Asking again shows the same panel rather than a second one.
  await page.locator(".pplot-label[data-dimension='optimizer']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  await expect(scatterPanels(page)).toHaveCount(before + 1);
});

test("distribution plots saved by an older page open as one-axis plots, once", async ({ page }) => {
  const saved = encodeURIComponent(
    JSON.stringify([
      { id: "1", axis: "optimizer" },
      { id: "2", axis: null },
    ]),
  );
  await page.goto(`/?hip.DISTRIBUTION.panels=${saved}`);
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  const plot = page.locator('[data-testid="distribution-plot"][data-axis="optimizer"]');
  await expect(plot).toHaveCount(1);
  const count = await scatterPanels(page).count();
  await reloadDemo(page);
  await expect(plot).toHaveCount(1);
  await expect(scatterPanels(page)).toHaveCount(count);
});

test("a row hovered elsewhere is marked in a one-axis plot", async ({ page }) => {
  await loadDemo(page);
  await page.locator(".pplot-label[data-dimension='lr']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  const plot = page.locator('[data-testid="distribution-plot"][data-axis="lr"]');
  await expect(plot).toBeVisible();
  const marks = plot.getByTestId("distribution-highlight");
  await expect(marks).toHaveCount(0);
  await page.locator("table.sample-rows-table tbody tr").first().hover();
  await expect(marks).toHaveCount(1);
  await page.locator(".dt-info").hover();
  await expect(marks).toHaveCount(0);
});
