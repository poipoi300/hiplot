import { loadParallelBenchmark } from "../bench/parallel";
import { expect, test } from "./fixtures";

interface ResizeWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        state: { height: number; width: number };
        h: number;
        continuousFrame: number;
        continuous: { busy: boolean; failure: Error | null };
        onResize: (height: number, width: number) => void;
      };
    };
  };
}

test("continuous density survives minimum and transient nondrawable resize", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadParallelBenchmark(
    page,
    { rows: 300, columns: 10, discrete: false, seed: 20261109 },
    "low",
  );
  const resizer = page.locator(".pplot-root").locator("..");
  const box = await resizer.boundingBox();
  if (box === null) throw new Error("Missing resize handle");
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y - 100, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().state.height,
      ),
    )
    .toBeLessThan(box.height - 100);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().h,
      ),
    )
    .toBeLessThanOrEqual(100);
  expect(
    await page.evaluate(
      () => (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().h,
    ),
  ).toBeGreaterThan(0);
  await page.evaluate(() => {
    const plot = (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot();
    plot.onResize(100, plot.state.width);
  });
  await page.waitForFunction(
    () =>
      (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().state.height ===
      100,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().h,
      ),
    )
    .toBe(0);
  const before = await page.evaluate(() => {
    const plot = (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot();
    const before = plot.continuousFrame;
    plot.onResize(400, plot.state.width);
    return before;
  });
  await page.waitForFunction((before) => {
    const plot = (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot();
    return plot.continuousFrame > before && !plot.continuous.busy;
  }, before);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as ResizeWindow).__parallelProbe.instance.parallelPlot().continuous
          .failure,
    ),
  ).toBeNull();
  expect(errors).toEqual([]);
});
