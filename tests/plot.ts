import type { Page } from "@playwright/test";

/**
 * Scrolls the parallel plot's axes to their right end, where the axes drawn
 * first in the DOM sit. The plot scrolls virtually (it draws what is in view),
 * so Playwright's scrollIntoViewIfNeeded cannot reach them.
 */
export async function scrollAxesToEnd(page: Page): Promise<void> {
  await page.getByTestId("pplot-scroller").evaluate((scroller) => {
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await page.waitForTimeout(100);
}
