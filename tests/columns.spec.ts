import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

interface ParallelPlotHandle {
  createScale: (column: string) => unknown;
  compute_dimensions: () => void;
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => ParallelPlotHandle | null };
}

async function loadDemo(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

const axes = (page: Page) => page.locator("svg g.dimension");
const columnOption = (page: Page, name: string) =>
  page
    .getByRole("dialog", { name: "Columns shown as axes" })
    .getByRole("option", { name, exact: true });

test("showing a column hidden since the page loaded adds its axis", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadDemo(page, `?hip.PARALLEL_PLOT.hide=${encodeURIComponent('["lr","optimizer"]')}`);
  const before = await axes(page).count();
  await page.getByTestId("columns-button").click();
  await columnOption(page, "lr").click();
  await expect(axes(page)).toHaveCount(before + 1);
  await columnOption(page, "optimizer").click();
  await expect(axes(page)).toHaveCount(before + 2);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a column whose axis cannot be built is refused and the columns stay", async ({ page }) => {
  await loadDemo(page, `?hip.PARALLEL_PLOT.hide=${encodeURIComponent('["lr"]')}`);
  const before = await axes(page).count();
  await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    pp.createScale = () => {
      throw new Error("no scale for this column");
    };
  });
  await page.getByTestId("columns-button").click();
  await columnOption(page, "lr").click();
  await expect(columnOption(page, "lr")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("toast")).toContainText('Could not show "lr"');
  await expect(page.getByTestId("toast")).toContainText("no scale for this column");
  await expect(axes(page)).toHaveCount(before);
  expect(new URL(page.url()).searchParams.get("hip.PARALLEL_PLOT.hide")).toContain("lr");
});

test("a display that crashes applying a change is rebuilt with its previous state", async ({
  page,
}) => {
  await loadDemo(page, `?hip.PARALLEL_PLOT.hide=${encodeURIComponent('["lr"]')}`);
  const before = await axes(page).count();
  await page.evaluate(() => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    pp.compute_dimensions = () => {
      throw new Error("layout failed");
    };
  });
  await page.getByTestId("columns-button").click();
  await columnOption(page, "lr").click();
  await expect(page.getByTestId("toast")).toContainText("was restored: layout failed");
  // The rebuilt plot is a fresh instance, without the broken layout, at the previous columns.
  await expect(axes(page)).toHaveCount(before);
  expect(new URL(page.url()).searchParams.get("hip.PARALLEL_PLOT.hide")).toContain("lr");
  await page.reload();
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(axes(page)).toHaveCount(before);
});

test("saved state of the wrong shape falls back to defaults with a toast", async ({ page }) => {
  await loadDemo(page, `?hip.PARALLEL_PLOT.order=${encodeURIComponent('"lr"')}`);
  await expect(page.getByTestId("toast")).toContainText('"PARALLEL_PLOT.order"');
  expect(await axes(page).count()).toBeGreaterThan(2);
  await page.getByTestId("toast").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});
