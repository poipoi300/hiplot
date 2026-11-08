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

async function open3D(page: Page) {
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
  return { canvas, box, label };
}

test("the 3D scatter pans with a right-drag, draws its plane fit and lassos a selection", async ({
  page,
}) => {
  const { canvas, box, label } = await open3D(page);
  await expect(scatterPanels(page).last().getByTestId("scatter3d-hint")).toContainText(
    "Right- or Shift-drag to pan",
  );
  await expect(scatterPanels(page).last().getByTestId("plane-fit")).toHaveAttribute("d", /^M/);
  await expect(scatterPanels(page).last().getByTestId("scatter3d-hint")).toContainText(
    "Plane: least squares in axis space",
  );

  const before = await label.getAttribute("style");
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(middle.x + 80, middle.y + 20, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => label.getAttribute("style")).not.toBe(before);

  const count = page.getByTestId("selection-count");
  const all = await count.textContent();
  await page.keyboard.down("Control");
  await page.mouse.move(middle.x - 120, middle.y - 90);
  await page.mouse.down();
  for (const [dx, dy] of [
    [120, -90],
    [120, 90],
    [-120, 90],
    [-120, -90],
  ]) {
    await page.mouse.move(middle.x + dx, middle.y + dy, { steps: 4 });
  }
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect.poll(() => count.textContent()).not.toBe(all);
  const prevented = await canvas.evaluate((element) => {
    const event = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
});

test("the 3D scatter zooms only for wheel gestures that start on it", async ({ page }) => {
  const { box, label } = await open3D(page);
  // Room to scroll on past the plot, however tall the page is.
  await page.evaluate(() => {
    document.body.style.paddingBottom = "1500px";
    window.scrollBy(0, -200);
  });
  const canvas = await scatterPanels(page)
    .last()
    .getByRole("img", { name: /3D scatter plot/ })
    .boundingBox();
  if (canvas === null) {
    throw new Error("No canvas");
  }
  const before = await label.getAttribute("style");
  // A page scroll that starts above the plot and carries on over it.
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y - 30);
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 40);
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, 40);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled + 40);
  expect(await label.getAttribute("style")).toBe(before);

  // After a pause, a gesture that starts on the plot zooms it, not the page.
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => window.scrollY);
  const box2 = await scatterPanels(page)
    .last()
    .getByRole("img", { name: /3D scatter plot/ })
    .boundingBox();
  await page.mouse.move(
    (box2?.x ?? box.x) + (box2?.width ?? box.width) / 2,
    (box2?.y ?? box.y) + (box2?.height ?? box.height) / 2,
  );
  const unzoomed = await label.getAttribute("style");
  await page.mouse.wheel(0, -120);
  await expect.poll(() => label.getAttribute("style")).not.toBe(unzoomed);
  expect(await page.evaluate(() => window.scrollY)).toBe(settled);
});

test("a scatter shows the correlations of the selection and fits it", async ({ page }) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await select(page, "X").selectOption("lr");
  await select(page, "Y").selectOption("exp_metric");
  const panel = scatterPanels(page).last();
  const stats = panel.getByTestId("scatter-stats");
  const table = stats.getByRole("table", { name: "Correlation of the selected rows" });
  await expect(table).toContainText("Pearson r");
  await expect(table).toContainText("Spearman ρ");
  const selected =
    (await page.getByTestId("selection-count").locator("strong").textContent()) ?? "";
  await expect(table.locator("td").nth(2)).toHaveText(selected);
  await expect(panel.getByTestId("scatter-fit")).toHaveAttribute("d", /^M/);
  await expect(stats).toContainText("Least squares: log₁₀(exp_metric) =");
  await expect(stats).toContainText("log₁₀(lr)");

  await stats.getByRole("button", { name: "Binned means" }).click();
  await expect(stats).toContainText("12 equal bins");
  await expect(panel.getByTestId("scatter-fit")).toHaveAttribute("d", /^M/);

  await select(page, "X").selectOption("optimizer");
  await expect(panel.getByTestId("scatter-category-mean")).toHaveCount(3);
  await expect(stats).toContainText("per optimizer, with its 95% interval");
});

test("a one-axis plot draws the best-fitting distribution and states it", async ({ page }) => {
  await loadDemo(page);
  await page.locator(".pplot-label[data-dimension='exp_metric']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
  const plot = page.locator('[data-testid="distribution-plot"][data-axis="exp_metric"]');
  await expect(plot.getByTestId("density-fit")).toHaveAttribute("d", /^M/);
  await expect(plot.getByTestId("density-kde")).toHaveAttribute("d", /^M/);
  const caption = plot.getByTestId("distribution-fit");
  await expect(caption).toContainText("f(x) =");
  await expect(caption).toContainText("Lowest BIC");
  await expect(caption).toContainText(/n = [\d,]+/);
});
