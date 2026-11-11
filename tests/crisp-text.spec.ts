import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loadDemo, pickColumn } from "./plot";

/** Tick labels whose glyphs start or whose baseline sits between device pixels. */
function ticksOffTheGrid(page: Page, ratio: number) {
  return page.evaluate((ratio) => {
    const off = (position: number) => Math.abs(position * ratio - Math.round(position * ratio));
    const texts = Array.from(
      document.querySelectorAll<SVGTextElement>(
        ".pplot-root .tick text, svg[aria-label^='XY scatter plot'] .tick text, [data-testid='distribution-plot'] .tick text",
      ),
    );
    const misses: string[] = [];
    for (const text of texts) {
      const frame = text.getScreenCTM();
      if (frame === null) {
        throw new Error("A tick label is not rendered");
      }
      const style = getComputedStyle(text);
      const fontSize = Number.parseFloat(style.fontSize);
      const length = (value: string | null) =>
        value === null
          ? 0
          : value.endsWith("em")
            ? Number.parseFloat(value) * fontSize
            : Number.parseFloat(value);
      const anchor = length(text.getAttribute("x"));
      const run = text.getComputedTextLength();
      const start =
        style.textAnchor === "end"
          ? anchor - run
          : style.textAnchor === "middle"
            ? anchor - run / 2
            : anchor;
      const left = frame.e + start * frame.a;
      const baseline =
        frame.f + (length(text.getAttribute("y")) + length(text.getAttribute("dy"))) * frame.d;
      if (off(left) > 0.02 || off(baseline) > 0.02) {
        misses.push(`${text.textContent} at ${left.toFixed(3)}, ${baseline.toFixed(3)}`);
      }
    }
    return { count: texts.length, misses };
  }, ratio);
}

for (const ratio of [1, 2]) {
  test.describe(`at a device pixel ratio of ${ratio}`, () => {
    test.use({ deviceScaleFactor: ratio, viewport: { width: 1600, height: 1000 } });

    test("axis tick labels start and sit on whole device pixels", async ({ page }) => {
      await loadDemo(page);
      await page.getByRole("button", { name: "Add scatter plot" }).click();
      const panel = page.getByTestId("scatter-panel").last();
      await pickColumn(panel, "X", "r");
      await pickColumn(panel, "Y", "pct_success");
      await expect(panel.locator(".tick text").first()).toBeAttached();
      await page.getByRole("button", { name: "Add scatter plot" }).click();
      const oneAxis = page.getByTestId("scatter-panel").last();
      await pickColumn(oneAxis, "X", "exp_metric");
      await expect(oneAxis.locator(".tick text").first()).toBeAttached();
      const { count } = await ticksOffTheGrid(page, ratio);
      expect(count).toBeGreaterThan(40);
      // Axis transitions snap their text only when they finish.
      await expect.poll(async () => (await ticksOffTheGrid(page, ratio)).misses).toEqual([]);
    });
  });
}

/** WCAG contrast of two `rgb(…)` colors. */
function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const [r, g, b] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ["Light", "Dark"] as const) {
  test(`axis titles and tick labels read at full contrast in the ${theme.toLowerCase()} theme`, async ({
    page,
  }) => {
    await loadDemo(page);
    await page.getByRole("button", { name: theme, exact: true }).click();
    const colors = await page.evaluate(() => {
      const tick = document.querySelector(".pplot-root .tick text");
      const title = document.querySelector(".pplot-root .pplot-label");
      const root = document.querySelector(".pplot-root");
      if (tick === null || title === null || root === null) {
        throw new Error("No axis");
      }
      const background = getComputedStyle(root).getPropertyValue("--hip-bg").trim();
      const probe = document.createElement("span");
      probe.style.color = background;
      root.appendChild(probe);
      const bg = getComputedStyle(probe).color;
      probe.remove();
      return {
        bg,
        tick: getComputedStyle(tick).fill,
        tickWeight: getComputedStyle(tick).fontWeight,
        title: getComputedStyle(title).fill,
        titleWeight: getComputedStyle(title).fontWeight,
      };
    });
    expect(contrast(colors.tick, colors.bg)).toBeGreaterThanOrEqual(14);
    expect(contrast(colors.title, colors.bg)).toBeGreaterThanOrEqual(15.5);
    expect(colors.tickWeight).toBe("500");
    expect(colors.titleWeight).toBe("600");
  });
}
