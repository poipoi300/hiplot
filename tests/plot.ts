import type { Locator, Page } from "@playwright/test";

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

/** The button of a scatter panel's axis ("X", "Y", "Z"), named "X: <column>". */
export const axisButton = (panel: Locator, axis: string): Locator =>
  panel.getByTestId(`axis-picker-${axis.toLowerCase()}`);

/** Picks `column` (null for None) on an axis of a scatter panel, from its list. */
export async function pickColumn(
  panel: Locator,
  axis: string,
  column: string | null,
): Promise<void> {
  await axisButton(panel, axis).click();
  await panel
    .getByRole("dialog", { name: `Column on ${axis}` })
    .getByRole("option", { name: column ?? "None", exact: true })
    .click();
}
