import { expect, test } from "@playwright/test";

test("load demo experiment", async ({ page }) => {
  // 1. Visit the root page
  await page.goto("/");

  // 2. Find the textarea and type "demo"
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await expect(input).toBeVisible();
  await input.fill("demo");
  await input.press("Enter");

  // 3. Wait for the experiment to load (look for HiPlot visualization)
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });

  // 4. Basic assertion that elements are present
  const dimensions = page.locator("svg g.dimension");
  expect(await dimensions.count()).toBeGreaterThan(0);
});
