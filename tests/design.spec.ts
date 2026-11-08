import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

/** Drags a brush over the middle of the `index`-th axis overlay. */
async function brushAxis(page: Page, index: number): Promise<void> {
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").nth(index);
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
}

const countText = (page: Page) => page.getByTestId("selection-count").textContent();

test("the legend names the color-by column and its categories", async ({ page }) => {
  await loadDemo(page);
  const legend = page.getByTestId("color-legend");
  await expect(legend).toContainText("Color");
  await expect(legend).toContainText("missing");
  await page.locator(".pplot-label[data-dimension='optimizer']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "Use for coloring" }).click();
  await expect(legend).toContainText("optimizer");
  await expect(legend.locator("li")).toHaveText(["adam", "adamw", "sgd"]);
});

test("brushing labels the brush ends and enables Reset brushes", async ({ page }) => {
  await loadDemo(page);
  const reset = page.getByRole("button", { name: "Reset brushes" });
  await expect(reset).toBeDisabled();
  const before = await countText(page);
  await brushAxis(page, 3);
  await expect.poll(() => countText(page)).not.toBe(before);
  await expect(page.locator("svg g.dimension text.pplot-brush-range")).toHaveCount(2);
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect.poll(() => countText(page)).toBe(before);
  await expect(reset).toBeDisabled();
  await expect(page.locator("svg g.dimension text.pplot-brush-range")).toHaveCount(0);
});

test("the line shape can be switched and is remembered", async ({ page }) => {
  await loadDemo(page);
  const group = page.getByRole("group", { name: "Line shape" });
  await expect(group.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  await group.getByRole("button", { name: "Straight" }).click();
  await expect(group.getByRole("button", { name: "Straight" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(page.url()).toContain("lineShape");
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(
    page.getByRole("group", { name: "Line shape" }).getByRole("button", { name: "Straight" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("hovering a line highlights it and names it", async ({ page }) => {
  await loadDemo(page);
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Straight" })
    .click();
  const svg = page.locator("svg[aria-label='Parallel coordinates axes']");
  const box = await svg.boundingBox();
  if (box === null) {
    throw new Error("No plot");
  }
  // Sweep down halfway between two axes, clear of their brush bands, until the pointer meets a line.
  const axes = await page
    .locator("svg g.dimension .domain")
    .evaluateAll((lines) =>
      lines.map((line) => line.getBoundingClientRect().left).sort((a, b) => a - b),
    );
  const between = (axes[2] + axes[3]) / 2;
  const tooltip = page.getByTestId("line-tooltip");
  for (let fraction = 0.3; fraction < 0.95 && !(await tooltip.isVisible()); fraction += 0.02) {
    await page.mouse.move(between, box.y + box.height * fraction);
    await page.waitForTimeout(30);
  }
  await expect(tooltip).toBeVisible();
  const highlighted = await page.evaluate(
    () =>
      (window as unknown as { hiplot_last_instance: { state: { rows_highlighted: unknown[] } } })
        .hiplot_last_instance.state.rows_highlighted.length,
  );
  expect(highlighted).toBe(1);
  await page.mouse.move(box.x + 2, box.y + 2);
  await expect(tooltip).toBeHidden();
});

const highlightedRows = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as { hiplot_last_instance: { state: { rows_highlighted: unknown[] } } })
        .hiplot_last_instance.state.rows_highlighted.length,
  );

test.describe("line highlight around brushes", () => {
  test("hovering where a brush is drawn or resized highlights nothing", async ({ page }) => {
    await loadDemo(page);
    const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").nth(3);
    const box = await overlay.boundingBox();
    if (box === null) {
      throw new Error("No brush overlay");
    }
    for (let fraction = 0.1; fraction < 0.95; fraction += 0.05) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction);
      await page.waitForTimeout(20);
      expect(await highlightedRows(page)).toBe(0);
    }
    await expect(page.getByTestId("line-tooltip")).toBeHidden();
  });

  test("drawing a brush clears the highlight for the whole gesture", async ({ page }) => {
    await loadDemo(page);
    const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").nth(3);
    const box = await overlay.boundingBox();
    if (box === null) {
      throw new Error("No brush overlay");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
    await page.mouse.down();
    for (let fraction = 0.32; fraction < 0.7; fraction += 0.04) {
      await page.mouse.move(box.x + box.width * 1.5, box.y + box.height * fraction);
      expect(await highlightedRows(page)).toBe(0);
    }
    await page.mouse.up();
    await expect(page.getByTestId("line-tooltip")).toBeHidden();
  });

  test("hovering a placed brush highlights the line under the pointer", async ({ page }) => {
    await loadDemo(page);
    await brushAxis(page, 3);
    const band = page.locator("svg g.dimension .pplot-brush rect.selection").nth(3);
    const box = await band.boundingBox();
    if (box === null) {
      throw new Error("No placed brush");
    }
    const tooltip = page.getByTestId("line-tooltip");
    for (let fraction = 0.02; fraction < 1 && !(await tooltip.isVisible()); fraction += 0.02) {
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * fraction);
      await page.waitForTimeout(30);
    }
    await expect(tooltip).toBeVisible();
    expect(await highlightedRows(page)).toBe(1);
  });
});

test("Auto names the line shape it chose and why", async ({ page }) => {
  await loadDemo(page);
  const hint = page.getByTestId("line-shape-hint");
  await expect(hint).toHaveText(/^Curved for [\d,]+ rows \(straight above 10,000\)$/);
  await page
    .getByRole("group", { name: "Line shape" })
    .getByRole("button", { name: "Curved" })
    .click();
  await expect(hint).toBeHidden();
});

test("axis titles keep their full name in the tooltip", async ({ page }) => {
  await loadDemo(page);
  const title = page.locator(".pplot-label[data-dimension='force_numericlog'] title");
  await expect(title).toHaveText(/^force_numericlog \(/);
});

test("the page loads nothing from third parties", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      external.push(request.url());
    }
  });
  await loadDemo(page);
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
  const fontLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('12px "IBM Plex Sans Variable"');
  });
  expect(fontLoaded).toBe(true);
});

test("the deselected-line color follows the theme", async ({ page }) => {
  const contextColor = async (theme: string): Promise<string> => {
    await page.goto(`/?hip.theme=${theme}`);
    return page.evaluate(() => {
      const root = document.querySelector(".hip_thm--light, .hip_thm--dark");
      return root === null
        ? ""
        : getComputedStyle(root).getPropertyValue("--hip-context-line").trim();
    });
  };
  const light = await contextColor("light");
  const dark = await contextColor("dark");
  expect(light).not.toBe("");
  expect(light).not.toBe(dark);
});

test("a numeric color map can be picked and is remembered", async ({ page }) => {
  await loadDemo(page);
  await page.locator(".pplot-label[data-dimension='lr']").click({ button: "right" });
  await page.locator(".context-menu .dropdown-item", { hasText: "Use for coloring" }).click();
  const button = page.getByTestId("color-map-button");
  await expect(button).toHaveText("Viridis");
  const gradient = () =>
    page
      .getByTestId("color-legend")
      .locator("[style*='linear-gradient']")
      .first()
      .getAttribute("style");
  const viridis = await gradient();
  await button.click();
  await page.getByRole("dialog", { name: "Color map" }).getByLabel("Magma").click();
  await expect(page.getByRole("dialog", { name: "Color map" })).toBeHidden();
  await expect(button).toHaveText("Magma");
  expect(await gradient()).not.toBe(viridis);
  expect(page.url()).toContain("color_map");
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(page.getByTestId("color-map-button")).toHaveText("Magma");
});
