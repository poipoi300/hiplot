import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

interface HiPlotWindow {
  hiplot?: { render?: unknown };
}

async function loadDemo(page: Page, uri = "demo_decay") {
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as HiPlotWindow).hiplot?.render, {
    timeout: 15000,
  });
  await expect(page.locator("#hiplot_element_id")).toBeVisible();
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await expect(input).toBeVisible();
  await input.fill(uri);
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await expect(page.locator("text=Loading HiPlot...")).toHaveCount(0);
}

/** Find the index of a parallel-plot dimension by its label text. */
async function findDimIndex(page: Page, labelName: string): Promise<number> {
  return page.evaluate((name: string) => {
    const dims = document.querySelectorAll("svg g.dimension");
    for (let i = 0; i < dims.length; i++) {
      // Titles may be truncated to fit; the column name is kept in data-dimension.
      const label = dims[i].querySelector(".pplot-label");
      if (label?.getAttribute("data-dimension") === name) return i;
    }
    return -1;
  }, labelName);
}

/** Get tick label texts for a parallel-plot dimension (excluding nan/inf/null). */
async function getTickLabels(page: Page, dimIndex: number): Promise<string[]> {
  return page.evaluate((idx: number) => {
    const dim = document.querySelectorAll("svg g.dimension")[idx];
    if (!dim) return [];
    const ticks = Array.from(dim.querySelectorAll(".tick text"));
    return ticks
      .map((t) => (t.textContent || "").trim())
      .filter((t) => t.length > 0 && t !== "nan/inf/null");
  }, dimIndex);
}

/**
 * Get bounding boxes of all tick labels within a parallel-plot dimension,
 * sorted top-to-bottom by vertical midpoint.
 */
async function getTickBBoxes(
  page: Page,
  dimIndex: number,
): Promise<{ text: string; top: number; bottom: number }[]> {
  return page.evaluate((idx: number) => {
    const dim = document.querySelectorAll("svg g.dimension")[idx];
    if (!dim) return [];
    const ticks = Array.from(dim.querySelectorAll(".tick text"));
    return ticks
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || "").trim(), top: r.top, bottom: r.bottom };
      })
      .filter((t) => t.text.length > 0)
      .sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
  }, dimIndex);
}

/**
 * Check whether adjacent tick labels overlap vertically.
 * Returns the fraction of adjacent pairs that overlap.
 */
function overlapFraction(bboxes: { top: number; bottom: number }[]): number {
  if (bboxes.length < 2) return 0;
  let overlapping = 0;
  for (let i = 0; i < bboxes.length - 1; i++) {
    if (bboxes[i].bottom > bboxes[i + 1].top + 1) {
      overlapping++;
    }
  }
  return overlapping / (bboxes.length - 1);
}

test.describe("parallel plot log-scale tick labels", () => {
  test("log-scale column labels its ticks as compact powers of ten", async ({ page }) => {
    await loadDemo(page);
    const dimIndex = await findDimIndex(page, "remaining_grams");
    expect(dimIndex).toBeGreaterThanOrEqual(0);
    const labels = await getTickLabels(page, dimIndex);
    expect(labels.length).toBeGreaterThan(0);
    // Powers of ten, written out from 0.01 to 1000 and as 1eN beyond (e.g. "1e-5")
    for (const label of labels) {
      expect(label).toMatch(/^(1e-?\d+|0\.0?1|10{0,3})$/);
    }
  });

  test("log-scale tick labels do not overlap", async ({ page }) => {
    await loadDemo(page);
    const dimIndex = await findDimIndex(page, "remaining_grams");
    expect(dimIndex).toBeGreaterThanOrEqual(0);
    const bboxes = await getTickBBoxes(page, dimIndex);
    expect(bboxes.length).toBeGreaterThan(1);
    expect(overlapFraction(bboxes)).toBe(0);
  });

  test("non-log columns are not corrupted by shared axis state", async ({ page }) => {
    await loadDemo(page);
    // Verify that plain numeric columns have tick labels that are NOT all
    // in scientific notation (regression: shared axis tickValues leak)
    const plainCols = ["initial_mass", "half_life", "elapsed_years"];
    for (const col of plainCols) {
      const dimIndex = await findDimIndex(page, col);
      expect(dimIndex, `column ${col} not found in parallel plot`).toBeGreaterThanOrEqual(0);
      const labels = await getTickLabels(page, dimIndex);
      expect(labels.length, `no tick labels for ${col}`).toBeGreaterThan(0);
      const allSci = labels.every((l) => /e[+-]?\d+/i.test(l));
      expect(allSci, `${col} tick labels are all scientific notation: ${labels.join(", ")}`).toBe(
        false,
      );
    }
  });

  test("non-log columns tick labels do not overlap", async ({ page }) => {
    await loadDemo(page);
    const plainCols = ["initial_mass", "half_life", "elapsed_years"];
    for (const col of plainCols) {
      const dimIndex = await findDimIndex(page, col);
      expect(dimIndex).toBeGreaterThanOrEqual(0);
      const bboxes = await getTickBBoxes(page, dimIndex);
      expect(bboxes.length).toBeGreaterThan(1);
      const overlap = overlapFraction(bboxes);
      expect(overlap, `tick labels overlap on ${col}`).toBe(0);
    }
  });
});

test.describe("distribution plot log-scale tick labels", () => {
  test("log-scale distribution axis uses scientific notation and does not overlap", async ({
    page,
  }) => {
    await loadDemo(page);
    // Open the distribution plot for remaining_grams via context menu
    const labels = page.locator(".pplot-label");
    await expect(labels.first()).toBeVisible();
    const labelTexts = await labels.evaluateAll((nodes) =>
      nodes.map((node) => {
        const textParts = Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => (child.textContent || "").trim())
          .filter((text) => text.length > 0);
        return textParts.join(" ").trim();
      }),
    );
    const targetIndex = labelTexts.indexOf("remaining_grams");
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    await labels.nth(targetIndex).click({ button: "right" });
    await expect(page.locator(".context-menu.show")).toBeVisible();
    await page.locator(".context-menu .dropdown-item", { hasText: "View distribution" }).click();
    await expect(
      page.locator('[data-testid="distribution-plot"][data-axis="remaining_grams"]'),
    ).toBeVisible();

    const result = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="distribution-plot"][data-axis="remaining_grams"]',
      );
      if (!root) return { error: "no-distribution-plot" };
      // The data axis is axisBottom in vertical mode
      const axisTicks = Array.from(root.querySelectorAll(".axisBottom .tick text"));
      const tickData = axisTicks
        .map((t) => {
          const r = t.getBoundingClientRect();
          return {
            text: (t.textContent || "").trim(),
            left: r.left,
            right: r.right,
          };
        })
        .filter((t) => t.text.length > 0)
        .sort((a, b) => a.left - b.left);
      const sciCount = tickData.filter((l) => /e[+-]?\d+/i.test(l.text)).length;
      // Check horizontal overlap for bottom axis
      let overlapCount = 0;
      for (let i = 0; i < tickData.length - 1; i++) {
        if (tickData[i].right > tickData[i + 1].left + 1) {
          overlapCount++;
        }
      }
      return {
        count: tickData.length,
        sciCount,
        overlapCount,
        sampleLabels: tickData.slice(0, 5).map((l) => l.text),
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThan(1);
    // All labels should be scientific notation
    expect(result.sciCount).toBe(result.count);
    // No overlapping labels
    expect(result.overlapCount).toBe(0);
  });
});
