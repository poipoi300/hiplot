import type { Page } from "@playwright/test";
import { loadParallelBenchmark } from "../bench/parallel";
import type { ContinuousImage } from "../src/parallel/continuous_types";
import type { ContinuousRenderer } from "../src/parallel/continuous_worker";
import type { LineGeometry } from "../src/parallel/geometry";
import type { LineColors, LineFrame, WebGLLineRenderer } from "../src/parallel/webgl";
import { expect, test } from "./fixtures";

interface Picture {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}
interface VisualPlot {
  webgl: WebGLLineRenderer;
  continuous: ContinuousRenderer | null;
  continuousFrame: number;
  continuousMetrics: ContinuousImage | null;
  foreground_ref: { current: HTMLCanvasElement };
  geometry: () => LineGeometry;
  selectionMask: (geometry: LineGeometry) => Uint8Array;
  lineFrame: (geometry: LineGeometry, mask: Uint8Array) => LineFrame;
}
interface VisualWindow {
  __parallelProbe: { instance: { parallelPlot: () => VisualPlot } };
  __visual: { exact: Picture; continuous?: Picture; frame: LineFrame };
}

async function capturePair(page: Page, mixed: boolean): Promise<void> {
  await page.setViewportSize({ width: 800, height: 700 });
  await loadParallelBenchmark(
    page,
    { rows: 8192, columns: 2, discrete: false, seed: 20261109 },
    "low",
  );
  const before = await page.evaluate((mixed) => {
    const win = window as unknown as VisualWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    if (pp.continuous === null) throw new Error("Production worker is missing");
    const geometry = pp.geometry();
    const mask = Uint8Array.from({ length: geometry.rows.length }, (_, row) =>
      Number(!mixed || row % 2 === 0),
    );
    const original = pp.lineFrame(geometry, mask);
    if (original.axes.length !== 2) throw new Error("Zero end tangents require two axes");
    const frame: LineFrame = {
      ...original,
      axes: original.axes.map((axis, index) => {
        const minimum = Math.min(...axis.pixels);
        const maximum = Math.max(...axis.pixels);
        return {
          x: index === 0 ? 32 : original.width - 32,
          pixels: Float32Array.from(
            axis.pixels,
            (y) => original.height * (0.1 + (0.8 * (y - minimum)) / (maximum - minimum)),
          ),
        };
      }),
      curved: true,
      draft: false,
      resolution: 1,
      pixelRatio: 1,
      lineWidth: 1,
      contextColor: { r: 32, g: 176, b: 224 },
      contextAlpha: 0.35,
      colorMode: "mean",
    };
    const colors: LineColors = {
      bins: Uint32Array.from(frame.axes[0].pixels, (y) => Number(y > frame.height / 2)),
      palette: [
        { r: 224, g: 48, b: 32 },
        { r: 64, g: 192, b: 80 },
      ],
      colorMapBins: 0,
    };
    pp.webgl.setRows(geometry.rows.length, geometry.order);
    pp.webgl.setDrawOrder(geometry.order);
    pp.webgl.setColors(colors);
    pp.webgl.setSelection(mask);
    pp.webgl.draw(frame);
    const canvas = pp.foreground_ref.current;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) throw new Error("Readback context is missing");
    context.drawImage(canvas, 0, 0);
    if (canvas.width !== frame.width || canvas.height !== frame.height)
      throw new Error("Picture comparison requires one device pixel per CSS pixel");
    win.__visual = {
      exact: {
        pixels: context.getImageData(0, 0, copy.width, copy.height).data,
        width: copy.width,
        height: copy.height,
      },
      frame,
    };
    const before = pp.continuousFrame;
    pp.continuous.draw(frame, colors, mask);
    return before;
  }, mixed);
  await page.waitForFunction((before) => {
    const pp = (window as unknown as VisualWindow).__parallelProbe.instance.parallelPlot();
    return pp.continuousFrame > before && !pp.continuous?.busy && !pp.webgl.busy;
  }, before);
  const images = await page.evaluate(() => {
    const win = window as unknown as VisualWindow;
    const pp = win.__parallelProbe.instance.parallelPlot();
    const image = pp.continuousMetrics;
    if (image === null || image.rows !== 8192) throw new Error("All-row worker image is missing");
    pp.webgl.present(image.pixels, image.width, image.height);
    const canvas = pp.foreground_ref.current;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) throw new Error("Readback context is missing");
    context.drawImage(canvas, 0, 0);
    win.__visual.continuous = {
      pixels: context.getImageData(0, 0, copy.width, copy.height).data,
      width: copy.width,
      height: copy.height,
    };
    const png = (picture: Picture): string => {
      context.putImageData(
        new ImageData(new Uint8ClampedArray(picture.pixels), picture.width, picture.height),
        0,
        0,
      );
      return copy.toDataURL("image/png");
    };
    return { exact: png(win.__visual.exact), continuous: png(win.__visual.continuous) };
  });
  for (const [name, image] of Object.entries(images)) {
    await test.info().attach(name, {
      body: Buffer.from(image.split(",")[1], "base64"),
      contentType: "image/png",
    });
  }
}

async function comparePictures(page: Page) {
  return page.evaluate(() => {
    const { exact, continuous, frame } = (window as unknown as VisualWindow).__visual;
    if (!continuous || exact.width !== continuous.width || exact.height !== continuous.height)
      throw new Error("Comparable pictures are missing");
    const { width, height } = exact;
    // Fixed two-CSS-pixel vertical box blur, in premultiplied RGBA, not endpoint-bin units.
    const radius = 2;
    const blur = (picture: Picture): Float64Array => {
      const result = new Float64Array(picture.pixels.length);
      for (let x = 0; x < width; ++x) {
        for (let y = 0; y < height; ++y) {
          const pixel = (y * width + x) * 4;
          const start = Math.max(0, y - radius);
          const end = Math.min(height - 1, y + radius);
          for (let row = start; row <= end; ++row) {
            const source = (row * width + x) * 4;
            const alpha = picture.pixels[source + 3];
            for (let channel = 0; channel < 4; ++channel)
              result[pixel + channel] +=
                channel === 3
                  ? alpha / (end - start + 1)
                  : (picture.pixels[source + channel] * alpha) / (255 * (end - start + 1));
          }
        }
      }
      return result;
    };
    const reference = blur(exact);
    const candidate = blur(continuous);
    const region = (start: number, end: number, lensEdges = false) => {
      let error = 0;
      let energy = 0;
      let referenceAlpha = 0;
      let candidateAlpha = 0;
      let painted = 0;
      let area = 0;
      for (let x = Math.ceil(start); x < end; ++x) {
        for (let y = 0; y < height; ++y) {
          // The saturated lens center hides profile errors; retain both outer quarters.
          if (lensEdges && !(y < height * 0.3 || y >= height * 0.7)) continue;
          area += 1;
          const pixel = (y * width + x) * 4;
          referenceAlpha += reference[pixel + 3];
          candidateAlpha += candidate[pixel + 3];
          painted += Number(reference[pixel + 3] > 32);
          for (let channel = 0; channel < 4; ++channel) {
            error += Math.abs(candidate[pixel + channel] - reference[pixel + channel]);
            energy += reference[pixel + channel];
          }
        }
      }
      return {
        relativeError: error / energy,
        alphaRatio: candidateAlpha / referenceAlpha,
        referenceAlpha,
        candidateAlpha,
        painted,
        area,
      };
    };
    const [left, right] = frame.axes.map((axis) => axis.x);
    const gap = right - left;
    const support = (picture: Picture, axis: number, direction: number) => {
      const masses: number[] = [];
      for (let distance = 0; distance < 20; ++distance) {
        const x = direction < 0 ? axis - 1 - distance : axis + distance;
        let mass = 0;
        for (let y = 0; y < height; ++y) mass += picture.pixels[(y * width + x) * 4 + 3];
        masses.push(mass);
      }
      return masses;
    };
    return {
      radius,
      width,
      height,
      rows: frame.drawnRows,
      axes: frame.axes.length,
      selected: frame.selectedCount,
      context: frame.contextCount,
      curve: [
        region(left + gap * 0.2, left + gap * 0.3, true),
        region(left + gap * 0.7, left + gap * 0.8, true),
      ],
      margins: [region(left - 15, left), region(right, right + 15)],
      inside: [region(left + 1, left + 8), region(right - 8, right - 1)],
      support: {
        exact: [support(exact, left, -1), support(exact, right, 1)],
        continuous: [support(continuous, left, -1), support(continuous, right, 1)],
      },
    };
  });
}

function expectNonblank(region: {
  referenceAlpha: number;
  candidateAlpha: number;
  painted: number;
  area: number;
}) {
  expect(region.referenceAlpha).toBeGreaterThan(region.area * 40);
  expect(region.candidateAlpha).toBeGreaterThan(region.area * 40);
  expect(region.painted).toBeGreaterThan(region.area * 0.5);
}

test("continuous lenses match exact half-gap Beziers with zero end tangents", async ({ page }) => {
  await capturePair(page, false);
  const result = await comparePictures(page);
  await test.info().attach("curve-metrics", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.radius).toBe(2);
  expect(result.axes).toBe(2);
  expect(result.rows).toBe(8192);
  for (const region of result.curve) {
    expectNonblank(region);
    expect.soft(region.relativeError).toBeLessThanOrEqual(0.065);
    expect.soft(Math.abs(region.alphaRatio - 1)).toBeLessThanOrEqual(0.04);
  }
});
