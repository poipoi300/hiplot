import { loadParallelBenchmark } from "../bench/parallel";
import type { ColorMode } from "../src/lib/colors";
import type { LineGeometry } from "../src/parallel/geometry";
import type { FinishedFrame, LineColors, LineFocus, LineFrame } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";
import { warmParallelWorker } from "./plot";

interface BlockPlot {
  exact: {
    busy: boolean;
    onImage: (bitmap: ImageBitmap, finished: FinishedFrame) => void;
  } | null;
  geometry: () => LineGeometry;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
  drawExactWorker: (
    frame: LineFrame,
    geometry: LineGeometry,
    colors: LineColors,
    mask: Uint8Array,
    focus: LineFocus | null,
  ) => boolean;
}

interface Comparison {
  step: number;
  fromBlocks: boolean;
  referenceFromBlocks: boolean;
  maximum: number;
  differing: number;
  ink: number;
}

/** `brushes` brushes on the focus axis; three have six edges, more than the partial slots. */
const CASES: {
  name: string;
  numeric: boolean;
  colorMode: ColorMode;
  curved: boolean;
  brushes: 1 | 3;
}[] = [
  { name: "numeric mean, curved", numeric: true, colorMode: "mean", curved: true, brushes: 1 },
  {
    name: "numeric mean, curved, three brushes",
    numeric: true,
    colorMode: "mean",
    curved: true,
    brushes: 3,
  },
  { name: "numeric mean, straight", numeric: true, colorMode: "mean", curved: false, brushes: 1 },
  {
    name: "numeric highest, curved",
    numeric: true,
    colorMode: "highest",
    curved: true,
    brushes: 1,
  },
  {
    name: "numeric lowest, straight",
    numeric: true,
    colorMode: "lowest",
    curved: false,
    brushes: 1,
  },
  { name: "categorical, curved", numeric: false, colorMode: "mean", curved: true, brushes: 1 },
];

for (const { name, numeric, colorMode, curved, brushes } of CASES) {
  for (const matchingFocus of [true, false]) {
    test(`brush frames from retained blocks equal full frames: ${name}, ${
      matchingFocus ? "matching" : "mismatched"
    } focus`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 480 });
      await loadParallelBenchmark(
        page,
        { rows: 6000, columns: 4, discrete: false, seed: 20261109 },
        "full",
      );
      const comparisons = await page.evaluate(
        async ({ numeric, colorMode, curved, matchingFocus, brushes }) => {
          const plot = (
            window as unknown as {
              __parallelProbe: { instance: { parallelPlot: () => BlockPlot } };
            }
          ).__parallelProbe.instance.parallelPlot();
          // The worker's premultiplied bytes as they are, which a 2D canvas's
          // unpremultiplied readback would round by up to half a level.
          const reader = document.createElement("canvas").getContext("webgl2");
          if (reader === null) throw new Error("Missing WebGL2 for pixel readback");
          const readBitmap = (bitmap: ImageBitmap): Uint8Array => {
            const gl = reader;
            const texture = gl.createTexture();
            const framebuffer = gl.createFramebuffer();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              texture,
              0,
            );
            const pixels = new Uint8Array(bitmap.width * bitmap.height * 4);
            gl.readPixels(0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            return pixels;
          };
          let image: { pixels: Uint8Array; finished: FinishedFrame } | null = null;
          let observed: BlockPlot["exact"] = null;
          const geometry = plot.geometry();
          const source = plot.lineFrame(geometry, plot.selectionMask(geometry));
          // Missing values on the brushed axis sort after every pixel; on the other, they fail its brush.
          const axes = source.axes.map((axis, index) => ({
            ...axis,
            pixels: Float32Array.from(axis.pixels, (y, row) =>
              (index === 1 && row % 17 === 0) || (index === 2 && row % 13 === 0) ? Number.NaN : y,
            ),
          }));
          const colors: LineColors = {
            bins: Uint32Array.from(geometry.order, (_, row) => row % 13),
            palette: Array.from({ length: 13 }, (_, bin) => ({
              r: (bin * 79) % 256,
              g: (bin * 37) % 256,
              b: (bin * 113) % 256,
            })),
            colorMapBins: numeric ? 12 : 0,
          };
          const height = source.height;
          const others = Uint8Array.from(axes[2].pixels, (y) => Number(y < 0.7 * height));
          const focusRows = matchingFocus ? others : new Uint8Array(others.length).fill(1);
          const draw = async (
            mask: Uint8Array,
            focus: LineFocus | null,
          ): Promise<{ pixels: Uint8Array; finished: FinishedFrame }> => {
            let selectedCount = 0;
            for (const flag of mask) selectedCount += flag;
            const frame: LineFrame = {
              ...source,
              axes,
              curved,
              draft: false,
              colorMode,
              selectedCount,
              contextCount: mask.length - selectedCount,
            };
            image = null;
            if (!plot.drawExactWorker(frame, geometry, colors, mask, focus))
              throw new Error("Missing exact worker support");
            const exact = plot.exact;
            if (exact === null) throw new Error("Missing exact renderer");
            if (observed !== exact) {
              const publish = exact.onImage.bind(exact);
              exact.onImage = (bitmap, finished) => {
                image = { pixels: readBitmap(bitmap), finished };
                publish(bitmap, finished);
              };
              observed = exact;
            }
            while (exact.busy || image === null) await new Promise(requestAnimationFrame);
            return image;
          };
          const comparisons: Comparison[] = [];
          // Brushes drawn from their tops: the bottom edges move, then cross back.
          for (const [step, reach] of [0.15, 0.22, 0.4, 0.21].entries()) {
            const tops = brushes === 1 ? [0.2] : [0.05, 0.35, 0.65];
            const extent = brushes === 1 ? reach : reach / 3;
            const mask = Uint8Array.from(axes[1].pixels, (y, row) =>
              Number(
                others[row] === 1 &&
                  tops.some((top) => y >= top * height && y <= (top + extent) * height),
              ),
            );
            const blocks = await draw(mask, { axis: 1, rows: focusRows, active: true });
            const reference = await draw(mask, null);
            let maximum = 0;
            let differing = 0;
            let ink = 0;
            if (blocks.pixels.length !== reference.pixels.length) {
              throw new Error("Block and full frames differ in size");
            }
            for (let i = 0; i < blocks.pixels.length; ++i) {
              if (i % 4 === 3) ink += blocks.pixels[i];
              const difference = Math.abs(blocks.pixels[i] - reference.pixels[i]);
              maximum = Math.max(maximum, difference);
              if (difference > 0) ++differing;
            }
            comparisons.push({
              step,
              fromBlocks: blocks.finished.fromBlocks,
              referenceFromBlocks: reference.finished.fromBlocks,
              maximum,
              differing,
              ink,
            });
          }
          return comparisons;
        },
        { numeric, colorMode, curved, matchingFocus, brushes },
      );
      for (const comparison of comparisons) {
        const label = `step ${comparison.step}`;
        expect(comparison.ink, label).toBeGreaterThan(0);
        expect(comparison.referenceFromBlocks, label).toBe(false);
        if (matchingFocus) expect(comparison.fromBlocks, label).toBe(true);
        expect(comparison.maximum, label).toBeLessThanOrEqual(1);
      }
      test
        .info()
        .annotations.push({ type: "comparisons", description: JSON.stringify(comparisons) });
    });
  }
}

test("brush gestures on a GPU draw full frames from retained blocks, through release", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await loadParallelBenchmark(
    page,
    { rows: 6000, columns: 4, discrete: false, seed: 20261109 },
    "full",
  );
  await warmParallelWorker(page);
  // The suite rasterizes on SwiftShader, whose worker reports no block frames
  // so that plots draft; blocks are as exact there, only slower.
  await page.evaluate(() => {
    const plot = (
      window as unknown as {
        __parallelProbe: { instance: { parallelPlot: () => { exact: object } } };
      }
    ).__parallelProbe.instance.parallelPlot();
    Object.assign(plot.exact, { blocks: true });
  });
  const result = await page.evaluate(async () => {
    interface GesturePlot extends BlockPlot {
      h: number;
      state: { dimensions: string[] };
      lineColors: (geometry: LineGeometry) => LineColors;
      exact: NonNullable<BlockPlot["exact"]> & {
        draw: (frame: LineFrame, ...rest: unknown[]) => void;
      };
      startBrushGesture: (
        event: { sourceEvent: { target: Element }; y: number },
        dimension: string,
      ) => void;
      continueBrushGesture: (y: number) => void;
      endBrushGesture: () => void;
    }
    const plot = (
      window as unknown as {
        __parallelProbe: { instance: { parallelPlot: () => GesturePlot } };
      }
    ).__parallelProbe.instance.parallelPlot();
    const reader = document.createElement("canvas").getContext("webgl2");
    if (reader === null) throw new Error("Missing WebGL2 for pixel readback");
    const readBitmap = (bitmap: ImageBitmap): Uint8Array => {
      const gl = reader;
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const pixels = new Uint8Array(bitmap.width * bitmap.height * 4);
      gl.readPixels(0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return pixels;
    };
    const exact = plot.exact;
    const drafts: boolean[] = [];
    const request = exact.draw.bind(exact);
    exact.draw = (frame, ...rest) => {
      drafts.push(frame.draft);
      request(frame, ...rest);
    };
    const images: { pixels: Uint8Array; fromBlocks: boolean }[] = [];
    const publish = exact.onImage.bind(exact);
    exact.onImage = (bitmap, finished) => {
      images.push({ pixels: readBitmap(bitmap), fromBlocks: finished.fromBlocks });
      publish(bitmap, finished);
    };
    const settled = async (): Promise<void> => {
      do await new Promise(requestAnimationFrame);
      while (exact.busy);
    };
    const dimension = plot.state.dimensions[1];
    const target = Array.from(document.querySelectorAll<SVGGElement>("g.dimension"))
      .find((node) => (node as SVGGElement & { __data__: string }).__data__ === dimension)
      ?.querySelector(".overlay");
    if (!target) throw new Error("Missing brush axis");
    plot.startBrushGesture({ sourceEvent: { target }, y: plot.h * 0.2 }, dimension);
    for (const bottom of [0.4, 0.45, 0.6]) {
      plot.continueBrushGesture(plot.h * bottom);
      await settled();
    }
    const gestureImages = images.length;
    plot.endBrushGesture();
    await settled();
    const release = images[images.length - 1];
    const geometry = plot.geometry();
    const mask = plot.selectionMask(geometry);
    plot.drawExactWorker(
      plot.lineFrame(geometry, mask),
      geometry,
      plot.lineColors(geometry),
      mask,
      null,
    );
    await settled();
    const reference = images[images.length - 1];
    let maximum = 0;
    for (let i = 0; i < release.pixels.length; ++i) {
      maximum = Math.max(maximum, Math.abs(release.pixels[i] - reference.pixels[i]));
    }
    let selected = 0;
    for (const flag of mask) selected += flag;
    return {
      drafts,
      gestureImages,
      fromBlocks: images.map((image) => image.fromBlocks),
      maximum,
      selected,
      rows: mask.length,
    };
  });
  expect(result.selected).toBeGreaterThan(0);
  expect(result.selected).toBeLessThan(result.rows);
  expect(result.drafts.every((draft) => !draft)).toBe(true);
  expect(result.gestureImages).toBe(3);
  // Gesture images and the release reuse the blocks; only the reference draws every row.
  expect(result.fromBlocks).toEqual([true, true, true, true, false]);
  expect(result.maximum).toBeLessThanOrEqual(1);
});
