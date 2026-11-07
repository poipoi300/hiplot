import { expect, test } from "./fixtures";

test.describe("Label Margin Tests", () => {
  test("labels should not be cut off with increased top margin", async ({ page }) => {
    // Go to main page
    await page.goto("http://localhost:8765/");

    // Enter 'demo' in the experiment textarea and submit
    const input = page.locator('textarea[placeholder="Experiments to load"]');
    await input.fill("demo");
    await input.press("Enter");

    // Wait for the parallel plot to render
    await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
    await page.waitForTimeout(1500);

    // Take a screenshot of the full page
    await page.screenshot({ path: "test-results/label-margin-full.png", fullPage: true });

    // Find all the pplot-label text elements
    const labels = page.locator(".pplot-label");
    const labelCount = await labels.count();
    console.log(`Found ${labelCount} pplot-label elements`);
    expect(labelCount).toBeGreaterThan(0);

    // Every axis title must lie entirely inside the plot's SVG: none is cut off
    // by the top margin or by the right edge.
    const svg = page.locator("svg[aria-label='Parallel coordinates axes']");
    const svgBox = await svg.boundingBox();
    expect(svgBox).not.toBeNull();
    const boxes = await labels.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    );
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual((svgBox?.y ?? 0) - 1);
      expect(box.left).toBeGreaterThanOrEqual((svgBox?.x ?? 0) - 1);
      expect(box.right).toBeLessThanOrEqual((svgBox?.x ?? 0) + (svgBox?.width ?? 0) + 1);
    }

    // Take a focused screenshot on the top area where labels are
    if (svgBox) {
      await page.screenshot({
        path: "test-results/label-margin-top-area.png",
        clip: {
          x: svgBox.x,
          y: svgBox.y,
          width: svgBox.width,
          height: 150,
        },
      });
    }

    console.log("Label margin test passed - labels should now have adequate space");
  });
});
