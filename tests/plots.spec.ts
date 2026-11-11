import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { axisButton, loadDemo, pickColumn } from "./plot";

const scatterPanels = (page: Page) => page.getByTestId("scatter-panel");
const pick = (page: Page, axis: string, column: string | null) =>
  pickColumn(scatterPanels(page).last(), axis, column);

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
  await expect(panel.getByTestId("scatter-empty")).toContainText("Pick a column on X, Y or Z");

  await pick(page, "X", "lr");
  await expect(panel.locator("svg").first()).toBeVisible();
  await expect(panel).toContainText("Distribution");

  await pick(page, "Y", "exp_metric");
  await expect(panel.getByRole("img", { name: "XY scatter plot" })).toBeVisible();

  await pick(page, "Z", "r");
  const scatter3d = panel.getByRole("img", { name: /3D scatter plot/ });
  await expect(scatter3d).toBeVisible();
  await expect(panel.locator("[data-axis-label='z-name']")).toHaveText("r");

  await reloadDemo(page);
  await expect(scatterPanels(page)).toHaveCount(before + 1);
  await expect(axisButton(scatterPanels(page).last(), "Z")).toHaveAccessibleName("Z: r");
});

test("any axis can be None: the set ones are plotted in order, and kept", async ({ page }) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = scatterPanels(page).last();
  for (const axis of ["X", "Y", "Z"]) {
    await expect(axisButton(panel, axis)).toHaveAccessibleName(`${axis}: None`);
  }
  await pick(page, "Z", "exp_metric");
  await expect(
    panel.locator('[data-testid="distribution-plot"][data-axis="exp_metric"]'),
  ).toBeVisible();

  await pick(page, "Y", "lr");
  const xy = panel.getByRole("img", { name: "XY scatter plot" });
  await expect(xy).toBeVisible();
  // Y runs across and Z up: the horizontal axis is drawn first.
  await expect(xy.locator(".plotxy-label")).toHaveText([/^lr/, /^exp_metric/]);
  // Polled: a label has no box until the plot has laid it out.
  const labels = xy.locator(".plotxy-label");
  await expect
    .poll(async () => {
      const [across, up] = await Promise.all([
        labels.nth(0).boundingBox(),
        labels.nth(1).boundingBox(),
      ]);
      return across !== null && up !== null && across.y > up.y;
    })
    .toBe(true);
  // The pickers keep their axes: X stays None.
  await expect(axisButton(panel, "X")).toHaveAccessibleName("X: None");
  await expect(axisButton(panel, "Y")).toHaveAccessibleName("Y: lr");
  await expect(axisButton(panel, "Z")).toHaveAccessibleName("Z: exp_metric");

  const saved = JSON.parse(new URL(page.url()).searchParams.get("hip.XY.panels") ?? "[]");
  expect(saved.at(-1)).toMatchObject({ x: null, y: "lr", z: "exp_metric" });
  await reloadDemo(page);
  const reloaded = scatterPanels(page).last();
  await expect(axisButton(reloaded, "X")).toHaveAccessibleName("X: None");
  await expect(reloaded.getByRole("img", { name: "XY scatter plot" })).toBeVisible();

  await pickColumn(reloaded, "Y", null);
  await pickColumn(reloaded, "Z", null);
  await expect(reloaded.getByTestId("scatter-empty")).toBeVisible();
});

test("the 3D scatter turns when dragged and names the point under the pointer", async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await pick(page, "X", "lr");
  await pick(page, "Y", "exp_metric");
  await pick(page, "Z", "r");
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
  await expect(axisButton(scatterPanels(page).last(), "X")).toHaveAccessibleName("X: optimizer");
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
  await pick(page, "X", "lr");
  await pick(page, "Y", "exp_metric");
  await pick(page, "Z", "r");
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
  const hint = scatterPanels(page).last().getByTestId("scatter3d-hint");
  await expect(hint).toContainText("Drag to turn · Right-, middle- or Shift-drag to pan");
  await expect(hint).toContainText("Ctrl-drag to lasso");
  // One drag vocabulary: no separate turn and select modes.
  await expect(scatterPanels(page).last().getByRole("group", { name: "3D drag tool" })).toHaveCount(
    0,
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
  const { label } = await open3D(page);
  const plot = scatterPanels(page)
    .last()
    .getByRole("img", { name: /3D scatter plot/ });
  // Room to scroll on past the plot, however tall the page is, and the plot
  // 200 px down the viewport: the first wheel goes above it, inside the page.
  await plot.evaluate((element) => {
    document.body.style.paddingBottom = "1500px";
    window.scrollBy(0, element.getBoundingClientRect().top - 200);
  });
  const canvas = await plot.boundingBox();
  if (canvas === null) {
    throw new Error("No canvas");
  }
  // Wheel events carry explicit timestamps: whether two of them belong to one
  // gesture must not depend on how fast the test runs.
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  const wheel = (x: number, y: number, deltaY: number, seconds: number) =>
    cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      timestamp: start + seconds,
    });
  const before = await label.getAttribute("style");
  // A page scroll that starts above the plot and carries on over it, 50 ms later.
  const centerX = canvas.x + canvas.width / 2;
  const scrolled = await page.evaluate(() => window.scrollY);
  const above = canvas.y - 100;
  // The gesture must start off the plot for this to test anything.
  expect(
    await plot.evaluate(
      (element, [x, y]) => element.contains(document.elementFromPoint(x, y)),
      [centerX, above],
    ),
  ).toBe(false);
  await wheel(centerX, above, 40, 0);
  await wheel(centerX, canvas.y + canvas.height / 2, 40, 0.05);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled + 40);
  expect(await label.getAttribute("style")).toBe(before);

  // A second later, a gesture that starts on the plot zooms it, not the page.
  const settled = await page.evaluate(() => window.scrollY);
  const moved = await plot.boundingBox();
  if (moved === null) {
    throw new Error("No canvas");
  }
  const unzoomed = await label.getAttribute("style");
  await wheel(moved.x + moved.width / 2, moved.y + moved.height / 2, -120, 1);
  await expect.poll(() => label.getAttribute("style")).not.toBe(unzoomed);
  expect(await page.evaluate(() => window.scrollY)).toBe(settled);
});

test("a scatter axis is picked from a filtered list, by keyboard or pointer, or set to None", async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = scatterPanels(page).last();
  const x = axisButton(panel, "X");
  await expect(x).toHaveAccessibleName("X: None");
  await x.click();
  const list = panel.getByRole("dialog", { name: "Column on X" });
  await expect(list.getByRole("option", { name: "Select all" })).toHaveCount(0);
  await expect(list.getByRole("button")).toHaveCount(0);
  await expect(list.getByRole("option", { name: "None", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const filter = list.getByRole("combobox", { name: "Filter columns" });
  await expect(filter).toBeFocused();
  await filter.fill("exp_met");
  await filter.press("Enter");
  await expect(list).toBeHidden();
  await expect(x).toHaveAccessibleName("X: exp_metric");

  await x.click();
  await expect(list.getByRole("option", { name: "exp_metric", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(list.getByRole("option", { selected: true })).toHaveCount(1);
  await list.getByRole("option", { name: "None", exact: true }).click();
  await expect(x).toHaveAccessibleName("X: None");
});

test("an axis list near the bottom of the window opens above its button and closes on scroll", async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  const panel = scatterPanels(page).last();
  const x = axisButton(panel, "X");
  await x.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize();
  const button = await x.boundingBox();
  if (viewport === null || button === null) {
    throw new Error("No viewport or button");
  }
  // Brings the button near the bottom of the window.
  await page.evaluate(
    (by) => window.scrollBy(0, by),
    button.y + button.height - viewport.height + 20,
  );
  await x.click();
  const list = panel.getByRole("dialog", { name: "Column on X" });
  await expect(list).toBeVisible();
  const [opened, placed] = [await x.boundingBox(), await list.boundingBox()];
  if (opened === null || placed === null) {
    throw new Error("No button or list");
  }
  expect(placed.y + placed.height).toBeLessThanOrEqual(opened.y);
  expect(placed.y).toBeGreaterThanOrEqual(0);
  await page.mouse.wheel(0, -120);
  await expect(list).toBeHidden();
});

test("a scatter shows the correlations of the selection and fits it", async ({ page }) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await pick(page, "X", "lr");
  await pick(page, "Y", "exp_metric");
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

  await pick(page, "X", "optimizer");
  await expect(panel.getByTestId("scatter-category-mean")).toHaveCount(3);
  await expect(stats).toContainText("per optimizer, with its 95% interval");
});

test("a scatter's fit is clipped out of the band of inf, NaN and missing values", async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Add scatter plot" }).click();
  await pick(page, "X", "lr");
  await pick(page, "Y", "special_values");
  const panel = scatterPanels(page).last();
  await expect(panel.getByTestId("scatter-fit")).toHaveAttribute("d", /^M/);
  const svg = panel.getByRole("img", { name: "XY scatter plot" });
  const { clipTop, bandTick } = await svg.evaluate((element) => {
    const clip = element.querySelector("clipPath[id^='plotxy-fit-clip'] rect");
    const tick = Array.from(element.querySelectorAll(".tick text")).find(
      (text) => text.textContent === "nan/inf/null",
    );
    if (clip === null || tick === undefined) {
      throw new Error("No fit clip or no band tick");
    }
    const tickBox = tick.getBoundingClientRect();
    return {
      clipTop: element.getBoundingClientRect().top + Number(clip.getAttribute("y")),
      bandTick: tickBox.top + tickBox.height / 2,
    };
  });
  // The band spans 30 pixels from its tick at the top of the axis.
  expect(clipTop - bandTick).toBeGreaterThanOrEqual(29.5);
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
