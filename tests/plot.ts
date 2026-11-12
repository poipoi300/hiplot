import type { Locator, Page } from "@playwright/test";
import type { HiPlot } from "../src/component";

/** Worker protocol tests supply a slow-frame observation independently of host GPU speed. */
export async function warmParallelWorker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as {
      __parallelProbe?: { instance: HiPlot };
      hiplot_last_instance?: HiPlot;
    };
    const plot = (win.__parallelProbe?.instance ?? win.hiplot_last_instance)?.parallelPlot();
    if (!plot) throw new Error("Missing parallel plot");
    plot.renderExecution.record(51);
    plot.renderExecution.record(51);
    plot.redrawLines();
  });
  await page.waitForFunction(() => {
    const win = window as unknown as {
      __parallelProbe?: { instance: HiPlot };
      hiplot_last_instance?: HiPlot;
    };
    const plot = (win.__parallelProbe?.instance ?? win.hiplot_last_instance)?.parallelPlot();
    return (
      plot &&
      !plot.linesBusy &&
      !plot.continuous?.busy &&
      (plot.continuousMode() ? plot.continuous?.execution === "worker" : plot.exact !== null)
    );
  });
}

export async function loadDemo(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

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
