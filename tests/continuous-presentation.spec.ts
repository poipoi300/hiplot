import { loadParallelBenchmark } from "../bench/parallel";
import { expect, test } from "./fixtures";

interface PresentationProbe {
  __parallelProbe: {
    instance: {
      parallelPlot: () => {
        webgl: {
          gl: WebGL2RenderingContext;
          present: (pixels: Uint8ClampedArray, width: number, height: number) => void;
        };
        foreground_ref: { current: HTMLCanvasElement };
      };
    };
  };
}

for (const scale of [1, 2]) {
  test(`worker image presentation at ${scale}x preserves premultiplied edge coverage`, async ({
    page,
  }) => {
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      "low",
    );
    const pixels = await page.evaluate((scale) => {
      const plot = (window as unknown as PresentationProbe).__parallelProbe.instance.parallelPlot();
      const canvas = plot.foreground_ref.current;
      canvas.width = 2 * scale;
      canvas.height = scale;
      // Hidden blue must not tint the red/transparent edge during enlargement.
      plot.webgl.present(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0]), 2, 1);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      plot.webgl.gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        plot.webgl.gl.RGBA,
        plot.webgl.gl.UNSIGNED_BYTE,
        pixels,
      );
      return Array.from(pixels);
    }, scale);
    const row =
      scale === 1
        ? [255, 0, 0, 255, 0, 0, 0, 0]
        : [255, 0, 0, 255, 191, 0, 0, 191, 64, 0, 0, 64, 0, 0, 0, 0];
    expect(pixels).toEqual(Array.from({ length: scale }, () => row).flat());
  });

  test(`worker image presentation at ${scale}x preserves both dimensions and top-down order`, async ({
    page,
  }) => {
    await loadParallelBenchmark(
      page,
      { rows: 3, columns: 2, discrete: false, seed: 20261109 },
      "low",
    );
    const pixels = await page.evaluate((scale) => {
      const plot = (window as unknown as PresentationProbe).__parallelProbe.instance.parallelPlot();
      const canvas = plot.foreground_ref.current;
      canvas.width = 2 * scale;
      canvas.height = 2 * scale;
      plot.webgl.present(
        new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 128]),
        2,
        2,
      );
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      plot.webgl.gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        plot.webgl.gl.RGBA,
        plot.webgl.gl.UNSIGNED_BYTE,
        pixels,
      );
      return Array.from(pixels);
    }, scale);
    // readPixels returns the bottom row first; the upload is top-down.
    const rows =
      scale === 1
        ? [
            [0, 0, 0, 0, 0, 128, 0, 128],
            [255, 0, 0, 255, 0, 0, 0, 0],
          ]
        : [
            [0, 0, 0, 0, 0, 32, 0, 32, 0, 96, 0, 96, 0, 128, 0, 128],
            [64, 0, 0, 64, 48, 24, 0, 72, 16, 72, 0, 88, 0, 96, 0, 96],
            [191, 0, 0, 191, 143, 8, 0, 151, 48, 24, 0, 72, 0, 32, 0, 32],
            [255, 0, 0, 255, 191, 0, 0, 191, 64, 0, 0, 64, 0, 0, 0, 0],
          ];
    expect(pixels).toEqual(rows.flat());
  });
}
