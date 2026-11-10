import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { ContinuousRenderer } from "../src/parallel/continuous_worker";
import type { LineColors, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface SupportWindow {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        continuousFrame: number;
        continuous: Pick<ContinuousRenderer, "draw" | "busy">;
        continuousMetrics: ContinuousImage;
      };
    };
  };
  __supportCase: { frame: LineFrame; colors: LineColors; mask: Uint8Array };
}

for (const kind of ["isolated", "left-stub", "right-stub"] as const) {
  test(`dense worker preserves ${kind} finite strip support`, async ({ page }) => {
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      "low",
    );
    for (const draft of [false, true]) {
      const before = await page.evaluate(
        ({ kind, draft }) => {
          const win = window as unknown as SupportWindow;
          const plot = win.__parallelProbe.instance.parallelPlot();
          if (!draft) {
            const left = [kind === "right-stub" ? Number.NaN : 64];
            const right = [kind === "left-stub" ? Number.NaN : 64];
            for (let a = 200; a < 225; ++a)
              for (let b = 200; b < 225; ++b) {
                left.push(a);
                right.push(b);
              }
            const mask = new Uint8Array(left.length);
            mask[0] = 1;
            win.__supportCase = {
              frame: {
                axes: [
                  { x: 0, pixels: new Float32Array(left) },
                  { x: 85, pixels: new Float32Array(right) },
                ],
                width: 85,
                height: 255,
                lineWidth: 1,
                pixelRatio: 1,
                curved: false,
                draft,
                resolution: 1,
                drawnRows: left.length,
                selectedCount: 1,
                contextCount: 625,
                contextColor: { r: 0, g: 255, b: 0 },
                contextAlpha: 0,
                colorMode: "mean",
              },
              colors: {
                bins: new Uint32Array(left.length),
                palette: [{ r: 255, g: 0, b: 0 }],
                colorMapBins: 0,
              },
              mask,
            };
          }
          const { frame, colors, mask } = win.__supportCase;
          plot.continuous.draw({ ...frame, draft }, colors, mask);
          return plot.continuousFrame;
        },
        { kind, draft },
      );
      await page.waitForFunction((before) => {
        const plot = (window as unknown as SupportWindow).__parallelProbe.instance.parallelPlot();
        return plot.continuousFrame > before && !plot.continuous.busy;
      }, before);
      const image = await page.evaluate((kind) => {
        const image = (window as unknown as SupportWindow).__parallelProbe.instance.parallelPlot()
          .continuousMetrics;
        const alpha = (x: number) => image.pixels[(64 * image.width + x) * 4 + 3];
        return {
          positive: alpha(kind === "right-stub" ? 80 : kind === "left-stub" ? 4 : 42),
          absent: alpha(kind === "right-stub" ? 66 : 18),
        };
      }, kind);
      expect(image.positive).toBeGreaterThan(0);
      if (kind !== "isolated") expect(image.absent).toBe(0);
    }
  });
}
