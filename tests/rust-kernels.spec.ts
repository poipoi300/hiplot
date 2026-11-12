import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { BrushMasks } from "../src/parallel/selection";
import type { Datapoint, ParamType } from "../src/types";
import { expect, test } from "./fixtures";

interface ProbeWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousMetrics: ContinuousImage | null;
        continuous: { busy: boolean } | null;
        brushMasks: () => BrushMasks;
        state: { dimensions: string[] };
        props: { rows_filtered: Datapoint[] };
      };
    };
  };
}

test("offline density pixels match when CSP blocks WebAssembly compilation", async ({
  page,
  context,
}) => {
  const images: { pixels: string; width: number; height: number; populated: boolean }[] = [];
  for (const blocked of [false, true]) {
    if (blocked) {
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const policy = document.createElement("meta");
          policy.httpEquiv = "Content-Security-Policy";
          policy.content = "script-src 'unsafe-inline' blob:; worker-src blob:";
          document.head.append(policy);
        });
      });
    }
    await loadParallelBenchmark(page, { rows: 512, columns: 2, discrete: false, seed: 20261111 });
    const compilationAllowed = await page.evaluate(() => {
      try {
        new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
        return true;
      } catch (error) {
        if (error instanceof WebAssembly.CompileError) return false;
        throw error;
      }
    });
    expect(compilationAllowed).toBe(!blocked);
    await context.setOffline(true);
    await page.getByTestId("render-quality-button").click();
    await page.getByRole("radio", { name: "Continuous density", exact: true }).click();
    await page.waitForFunction(() => {
      const plot = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      return plot.continuousMetrics !== null && plot.continuous !== null && !plot.continuous.busy;
    });
    images.push(
      await page.evaluate(() => {
        const image = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot()
          .continuousMetrics;
        if (image === null) throw new Error("Missing offline density image");
        // A lossless byte string avoids serializing millions of individual protocol values.
        const chunks: string[] = [];
        for (let offset = 0; offset < image.pixels.length; offset += 16384)
          chunks.push(String.fromCharCode(...image.pixels.subarray(offset, offset + 16384)));
        return {
          pixels: btoa(chunks.join("")),
          width: image.width,
          height: image.height,
          populated: image.pixels.some((value, channel) => channel % 4 === 3 && value > 0),
        };
      }),
    );
    const brushResult = await page.evaluate(async () => {
      const plot = (window as unknown as ProbeWindow).__parallelProbe.instance.parallelPlot();
      const dimension = plot.state.dimensions[0];
      const ranges = new Map([
        [dimension, [{ col: dimension, type: "numeric" as ParamType.NUMERIC, min: 0.2, max: 0.7 }]],
      ]);
      const masks = plot.brushMasks();
      await masks.prepare(ranges);
      const actual = masks.select(ranges);
      const numericDifferences = plot.props.rows_filtered.reduce((differences, row, index) => {
        const value = Number(row[dimension]);
        return differences + Number(actual[index] !== Number(value >= 0.2 && value <= 0.7));
      }, 0);
      const categories = ["😀", "\ud800", "é", "z", "\udfff", "\ue000", "e\u0301"];
      plot.props.rows_filtered.forEach((row, index) => {
        row.category = categories[index % categories.length];
      });
      const categoryRanges = new Map([
        [
          "category",
          [
            {
              col: "category",
              type: "categorical" as ParamType.CATEGORICAL,
              min: "\ud800",
              max: "\ue000",
            },
          ],
        ],
      ]);
      await masks.prepare(categoryRanges);
      const categorical = masks.select(categoryRanges);
      const categoricalDifferences = plot.props.rows_filtered.reduce((differences, row, index) => {
        const value = String(row.category);
        return (
          differences +
          Number(categorical[index] !== Number(value >= "\ud800" && value <= "\ue000"))
        );
      }, 0);
      return { numericDifferences, categoricalDifferences, wasmBytes: masks.wasmMemoryBytes };
    });
    expect(brushResult.numericDifferences).toBe(0);
    expect(brushResult.categoricalDifferences).toBe(0);
    if (blocked) expect(brushResult.wasmBytes).toBe(0);
    else expect(brushResult.wasmBytes).toBeGreaterThan(0);
    await context.setOffline(false);
  }
  expect(images[0].populated).toBe(true);
  expect(images[1]).toEqual(images[0]);
});
