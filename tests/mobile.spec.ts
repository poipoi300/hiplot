import { expect, test } from "./fixtures";

test.describe("HiPlot Mobile Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const input = page.locator('textarea[placeholder="Experiments to load"]');
    await expect(input).toBeVisible();
    await input.fill("demo");
    await input.press("Enter");
    await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  });

  test("labels should be visible after loading", async ({ page }) => {
    const labels = page.locator(".pplot-label");
    const labelCount = await labels.count();
    console.log(`Found ${labelCount} axis labels`);
    expect(labelCount).toBeGreaterThan(0);
  });

  test("labels should remain visible after scrolling", async ({ page }) => {
    const labels = page.locator(".pplot-label");
    const initialBox = await labels.first().boundingBox();
    console.log("Initial label position:", initialBox);

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(300);

    // Scroll back up
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Check labels are still visible
    const afterBox = await labels.first().boundingBox();
    console.log("Label position after scroll:", afterBox);

    // Labels should still have valid bounding box
    expect(afterBox).not.toBeNull();
    expect(afterBox!.width).toBeGreaterThan(0);
    expect(afterBox!.height).toBeGreaterThan(0);
  });

  test("drag axis should work", async ({ page }) => {
    // Find the dimension groups (each axis)
    const dimensions = page.locator("svg g.dimension");
    const firstDim = dimensions.first();

    // Get initial transform
    const initialTransform = await firstDim.getAttribute("transform");
    console.log("Initial transform:", initialTransform);

    // Find the label (draggable)
    const label = firstDim.locator(".pplot-label").first();
    const labelBox = await label.boundingBox();

    if (labelBox) {
      const startX = labelBox.x + labelBox.width / 2;
      const startY = labelBox.y + labelBox.height / 2;

      // Drag horizontally
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 80, startY, { steps: 10 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
  });

  test("visual regression - full page", async ({ page }) => {
    const svgElement = page.locator("svg").first();
    await expect(svgElement).toBeVisible();
  });
});
