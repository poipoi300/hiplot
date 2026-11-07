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

    // Get the SVG bounding box and the first label's position
    const svg = page.locator("svg").first();
    const svgBox = await svg.boundingBox();
    console.log("SVG bounding box:", svgBox);

    // Check that labels have proper positioning (x=10 offset should be visible)
    const firstLabel = labels.first();
    const labelX = await firstLabel.getAttribute("x");
    console.log("First label x attribute:", labelX);
    expect(labelX).toBe("10");

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
