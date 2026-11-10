import { loadParallelBenchmark } from "../bench/parallel";
import type { LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

for (const [draft, numeric] of [
  [false, false],
  [false, true],
  [true, false],
] as const) {
  test(`dense ${draft ? "draft" : "final"} ${numeric ? "numeric" : "categorical"} frames conserve coverage and color`, async ({
    page,
  }) => {
    await loadParallelBenchmark(page, { rows: 10, columns: 2, discrete: true, seed: 20261109 });
    const result = await page.evaluate(
      ({ draft, numeric }) => {
        const win = window as unknown as {
          __parallelProbe: {
            instance: {
              parallelPlot: () => {
                webgl: Pick<
                  WebGLLineRenderer,
                  "setRows" | "setSelection" | "setColors" | "draw"
                > & {
                  gl: WebGL2RenderingContext;
                  density: { framebuffer: WebGLFramebuffer; width: number; height: number };
                };
                foreground_ref: { current: HTMLCanvasElement };
              };
            };
          };
        };
        const pp = win.__parallelProbe.instance.parallelPlot();
        const renderer = pp.webgl;
        const canvas = pp.foreground_ref.current;
        canvas.width = 64;
        canvas.height = 8;
        const rows = 8192;
        renderer.setRows(
          rows,
          Uint32Array.from({ length: rows }, (_, row) => row),
        );
        renderer.setSelection(new Uint8Array(rows).fill(1));
        renderer.setColors({
          bins: new Uint32Array(rows).fill(numeric ? 1 : 0),
          palette: [
            { r: 51, g: 153, b: 204 },
            { r: 51, g: 153, b: 204 },
            { r: 200, g: 0, b: 0 },
          ],
          colorMapBins: numeric ? 2 : 0,
        });
        const frame: LineFrame = {
          axes: [8, 56].map((x) => ({ x, pixels: new Float32Array(rows).fill(4.5) })),
          width: 64,
          height: 8,
          lineWidth: 1,
          pixelRatio: 1,
          curved: false,
          draft,
          resolution: 1,
          drawnRows: rows,
          selectedCount: rows,
          contextCount: 0,
          contextColor: { r: 0, g: 0, b: 0 },
          contextAlpha: 0,
          colorMode: "mean",
        };
        renderer.draw(frame);
        const gl = renderer.gl;
        const pixel = new Uint8Array(4);
        gl.readPixels(32, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.density.framebuffer);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        const coverage = new Float32Array(4);
        gl.readPixels(32, 3, 1, 1, gl.RGBA, gl.FLOAT, coverage);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { coverage: coverage[0], pixel: Array.from(pixel), error: gl.getError() };
      },
      { draft, numeric },
    );
    expect(result.error).toBe(0);
    expect(result.coverage, JSON.stringify(result)).toBe(8192);
    const alpha = Math.log1p(8192) / Math.log1p((12 * 8192) / 8);
    for (const [channel, expected] of [
      51 * alpha,
      153 * alpha,
      204 * alpha,
      255 * alpha,
    ].entries()) {
      expect(Math.abs(result.pixel[channel] - expected)).toBeLessThanOrEqual(1);
    }
  });
}
