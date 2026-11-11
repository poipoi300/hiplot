import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loadDemo } from "./plot";

/** The first axis whose brush band is wholly in view. */
async function axisInView(page: Page): Promise<Locator> {
  const width = page.viewportSize()?.width ?? 0;
  const axes = page.locator("svg g.dimension");
  for (let index = 0; index < (await axes.count()); ++index) {
    const box = await axes.nth(index).locator(".pplot-brush rect.overlay").boundingBox();
    if (box !== null && box.x > 80 && box.x + box.width < width - 40) {
      return axes.nth(index);
    }
  }
  throw new Error("No axis in view");
}

/** Brushes an axis, then measures the brush's centre and the axis line, in page pixels. */
async function brushAndMeasure(page: Page): Promise<{ brushCentre: number; axisLine: number }> {
  const axis = await axisInView(page);
  const overlay = await axis.locator(".pplot-brush rect.overlay").boundingBox();
  if (overlay === null) {
    throw new Error("The brush band is not displayed");
  }
  const x = overlay.x + overlay.width / 2;
  await page.mouse.move(x, overlay.y + overlay.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(x, overlay.y + overlay.height * 0.6, { steps: 5 });
  await page.mouse.up();
  const band = axis.locator(".pplot-brush rect.selection");
  await expect(band).toHaveCount(1);
  const brush = await band.boundingBox();
  const line = await axis.locator("path.domain").boundingBox();
  if (brush === null || line === null) {
    throw new Error("The brush or the axis line is not displayed");
  }
  return { brushCentre: brush.x + brush.width / 2, axisLine: line.x + line.width / 2 };
}

for (const deviceScaleFactor of [1, 1.5, 2]) {
  test.describe(`at a device pixel ratio of ${deviceScaleFactor}`, () => {
    test.use({ viewport: { width: 1900, height: 1000 }, deviceScaleFactor });

    test("a brush is centred on its axis line", async ({ page }) => {
      await loadDemo(page);
      const { brushCentre, axisLine } = await brushAndMeasure(page);
      expect(Math.abs(brushCentre - axisLine)).toBeLessThanOrEqual(0.5);
    });
  });
}

test.describe("on scrolled axes", () => {
  test.use({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });

  test("a brush is centred on its axis line after a scroll by a fraction of a pixel", async ({
    page,
  }) => {
    await loadDemo(page);
    const scrolled = await page.getByTestId("pplot-scroller").evaluate((scroller) => {
      scroller.scrollLeft = 137.5;
      return scroller.scrollLeft;
    });
    expect(scrolled).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    const { brushCentre, axisLine } = await brushAndMeasure(page);
    expect(Math.abs(brushCentre - axisLine)).toBeLessThanOrEqual(0.5);
  });
});
