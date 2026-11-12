import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loadDemo, scrollAxesToEnd } from "./plot";

interface ParallelPlotHandle {
  webgl: unknown;
  foreground: unknown;
  redrawLines: () => void;
  foreground_ref: { current: HTMLCanvasElement | null };
  exact_image_ref: { current: HTMLCanvasElement | null };
  exact: { busy: boolean } | null;
}
interface HiPlotWindow {
  hiplot_last_instance?: { parallelPlot: () => ParallelPlotHandle | null };
}

/** Counts the line canvas pixels that are not transparent, right after a redraw. */
async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    let canvas = pp?.foreground_ref.current;
    if (!pp || !canvas) {
      throw new Error("No parallel plot");
    }
    pp.redrawLines();
    if (pp.exact !== null) {
      while (pp.exact.busy) await new Promise(requestAnimationFrame);
      canvas = pp.exact_image_ref.current;
      if (!canvas) throw new Error("No completed line surface");
    }
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) {
      throw new Error("No 2D context");
    }
    // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) {
      painted += data[i] > 0 ? 1 : 0;
    }
    return painted;
  });
}

async function renderer(page: Page): Promise<"webgl" | "canvas"> {
  return page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot();
    if (!pp) {
      throw new Error("No parallel plot");
    }
    return pp.webgl !== null ? "webgl" : "canvas";
  });
}

test("parallel lines are drawn with WebGL when it is available", async ({ page }) => {
  await loadDemo(page);
  expect(await renderer(page)).toBe("webgl");
  expect(await paintedPixels(page)).toBeGreaterThan(1000);
});

test("during a drag, frames wait for the GPU to finish the last one instead of queueing", async ({
  page,
}) => {
  await loadDemo(page);
  const draws = await page.evaluate(async () => {
    interface PacingProbe {
      webgl: object;
      interacting: boolean;
      redrawLines: () => void;
      drawWithWebGL: (webgl: object) => void;
    }
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
      | (ParallelPlotHandle & PacingProbe)
      | null;
    if (!pp) {
      throw new Error("No parallel plot");
    }
    let busy = true;
    Object.defineProperty(pp.webgl, "busy", { get: () => busy });
    let count = 0;
    const draw = pp.drawWithWebGL.bind(pp);
    pp.drawWithWebGL = (webgl) => {
      count += 1;
      draw(webgl);
    };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const counts: number[] = [];
    pp.interacting = true;
    for (let i = 0; i < 5; ++i) {
      pp.redrawLines();
    }
    await nextFrame();
    await nextFrame();
    counts.push(count); // still busy: nothing drawn
    busy = false;
    await nextFrame();
    await nextFrame();
    counts.push(count); // the five requests drew once
    busy = true;
    pp.interacting = false;
    pp.redrawLines();
    counts.push(count); // outside a drag, a frame is drawn right away
    return counts;
  });
  expect(draws).toEqual([0, 1, 2]);
});

test("parallel lines fall back to Canvas 2D without WebGL2", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      options?: unknown,
    ) {
      return kind === "webgl2" ? null : getContext.call(this, kind, options);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await loadDemo(page);
  expect(await renderer(page)).toBe("canvas");
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(1000);

  // Brushing still selects and redraws through the fallback.
  const countLine = page.getByTestId("selection-count");
  const before = await countLine.textContent();
  // The first overlay is the rightmost axis, out of view when the axes scroll.
  await scrollAxesToEnd(page);
  const overlay = page.locator("svg g.dimension .pplot-brush rect.overlay").first();
  const box = await overlay.boundingBox();
  if (box === null) {
    throw new Error("No brush overlay");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countLine.textContent()).not.toBe(before);
});

interface CoverageProbe {
  position: (dimension: string) => number;
  yscale: { [dimension: string]: (value: number) => number };
  scrollLeft: number;
  pixelRatio: number;
  state: { dimensions: string[] };
}

test("a steep straight line keeps its width instead of breaking into dots", async ({ page }) => {
  // Two mirrored rows over twelve close axes: each runs from the bottom of an
  // axis to the top of the next, so every segment is steep.
  const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const rising = names.map((_, i) => i % 2);
  const falling = names.map((_, i) => 1 - (i % 2));
  // Upright axes: facing the color would flip every other one and flatten the zigzag.
  await page.goto(
    `/?provider=upload&hip.PARALLEL_PLOT.upright=${encodeURIComponent(JSON.stringify(names))}`,
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "steep.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([names, rising, falling].map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await page.getByRole("button", { name: "Straight", exact: true }).click();

  // Coverage of the rising line per pixel row, in a window around where it
  // crosses the row, over the part of the gap the other line keeps clear of.
  const rowSums = await page.evaluate(async () => {
    const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
      | (ParallelPlotHandle & CoverageProbe)
      | null;
    let canvas = pp?.foreground_ref.current;
    if (!pp || !canvas) {
      throw new Error("No parallel plot");
    }
    pp.redrawLines();
    if (pp.exact !== null) {
      while (pp.exact.busy) await new Promise(requestAnimationFrame);
      canvas = pp.exact_image_ref.current;
      if (!canvas) throw new Error("No completed line surface");
    }
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) {
      throw new Error("No 2D context");
    }
    context.drawImage(canvas, 0, 0);
    const [first, second] = pp.state.dimensions;
    const ratio = pp.pixelRatio;
    const left = (pp.position(first) - pp.scrollLeft) * ratio;
    const right = (pp.position(second) - pp.scrollLeft) * ratio;
    const bottom = pp.yscale[first](0) * ratio;
    const top = pp.yscale[second](1) * ratio;
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const sums: number[] = [];
    for (
      let y = Math.round(bottom - 0.1 * (bottom - top));
      y > bottom - 0.4 * (bottom - top);
      --y
    ) {
      const crossing = left + ((bottom - y) / (bottom - top)) * (right - left);
      let sum = 0;
      for (let x = Math.floor(crossing) - 3; x <= Math.ceil(crossing) + 3; ++x) {
        sum += data[(y * copy.width + x) * 4 + 3];
      }
      sums.push(sum);
    }
    return sums;
  });
  expect(rowSums.length).toBeGreaterThan(40);
  expect(Math.min(...rowSums)).toBeGreaterThan(0.6 * Math.max(...rowSums));
});

interface BundleProbe {
  props: { rows_filtered: ReadonlyArray<Record<string, number>> };
}

for (const deviceScaleFactor of [0.5, 1, 2]) {
  test.describe(`at device pixel ratio ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });

    test("a bundle of identical steep lines keeps the anti-aliased edge of one line", async ({
      page,
    }) => {
      // Two hundred identical rows zigzag from the bottom of each axis to the
      // top of the next; one mirrored row gives every axis its range. The
      // bundle is dense enough for the tone mapping to saturate.
      const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
      const bundle = names.map((_, i) => i % 2);
      const mirrored = names.map((_, i) => 1 - (i % 2));
      const rows = [...Array.from({ length: 200 }, () => bundle), mirrored];
      // The rows' uids, their index, would be an axis of their own, fanning the bundle out.
      // A categorical color has no gradient for the axes to face, which would flatten the zigzag.
      await page.goto(
        `/?provider=upload&hip.PARALLEL_PLOT.hide=${encodeURIComponent('["uid"]')}` +
          `&hip.color_by=${encodeURIComponent('"c0"')}`,
      );
      await page.locator("input[type=file]").setInputFiles({
        name: "bundle.csv",
        mimeType: "text/csv",
        buffer: Buffer.from([names, ...rows].map((row) => row.join(",")).join("\n")),
      });
      await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
      await page.getByRole("button", { name: "Straight", exact: true }).click();

      // Per pixel row, the bundle's opacity summed in a window around where it
      // crosses the row, next to the exact coverage of one opaque line along
      // the same segment.
      const rowSums = await page.evaluate(async () => {
        const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
          | (ParallelPlotHandle & CoverageProbe & BundleProbe)
          | null;
        let canvas = pp?.foreground_ref.current;
        if (!pp || !canvas) {
          throw new Error("No parallel plot");
        }
        pp.redrawLines();
        if (pp.exact !== null) {
          while (pp.exact.busy) await new Promise(requestAnimationFrame);
          canvas = pp.exact_image_ref.current;
          if (!canvas) throw new Error("No completed line surface");
        }
        const opacities = (draw: (context: CanvasRenderingContext2D) => void) => {
          const copy = document.createElement("canvas");
          copy.width = canvas.width;
          copy.height = canvas.height;
          const context = copy.getContext("2d");
          if (context === null) {
            throw new Error("No 2D context");
          }
          draw(context);
          return context.getImageData(0, 0, copy.width, copy.height).data;
        };
        const [first, second] = pp.state.dimensions;
        const row = pp.props.rows_filtered[0];
        const ratio = pp.pixelRatio;
        const start = [
          (pp.position(first) - pp.scrollLeft) * ratio,
          pp.yscale[first](row[first]) * ratio,
        ];
        const end = [
          (pp.position(second) - pp.scrollLeft) * ratio,
          pp.yscale[second](row[second]) * ratio,
        ];
        // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
        const drawn = opacities((context) => context.drawImage(canvas, 0, 0));
        // One opaque line of one CSS pixel covers, in each pixel row it
        // crosses, its width over the sine of its angle to the horizontal.
        const rowCoverage =
          (ratio * Math.hypot(end[0] - start[0], end[1] - start[1])) / Math.abs(end[1] - start[1]);
        // From 10% to 40% of the way along the segment, clear of the axes and
        // of the mirrored line, which crosses the bundle halfway.
        const sums: { drawn: number; reference: number }[] = [];
        const [from, to] = [0.1, 0.4].map((t) => start[1] + t * (end[1] - start[1]));
        for (let y = Math.ceil(Math.min(from, to)); y < Math.max(from, to); ++y) {
          const t = (y + 0.5 - start[1]) / (end[1] - start[1]);
          const crossing = Math.round(start[0] + t * (end[0] - start[0]));
          const sum = { drawn: 0, reference: rowCoverage };
          for (let x = crossing - 4; x <= crossing + 4; ++x) {
            sum.drawn += drawn[(y * canvas.width + x) * 4 + 3] / 255;
          }
          sums.push(sum);
        }
        return sums;
      });
      expect(rowSums.length).toBeGreaterThan(40 * deviceScaleFactor);
      // A saturated bundle drawn without anti-aliasing covers two full pixels
      // per row where one line covers about one, spread over its edge.
      for (const { drawn, reference } of rowSums) {
        expect(drawn / reference).toBeGreaterThan(0.85);
        expect(drawn / reference).toBeLessThan(1.15);
      }
    });

    test("a dense bundle of identical lines keeps one color along its length", async ({ page }) => {
      // Five thousand rows share one segment and one color: every pixel the
      // bundle crosses sums thousands of coverages, where a half-float sum
      // stops growing at a point that depends on the pixel's coverage.
      const bundle = Array.from({ length: 5000 }, () => [0, 3, 0.5]);
      await uploadRows(page, ["a", "b", "c"], [...bundle, ...RANGE_ROWS], "c");
      const profile = await segmentProfile(page);
      expect(profile.length).toBeGreaterThan(40 * deviceScaleFactor);
      const median = (values: number[]) => [...values].sort((x, y) => x - y)[values.length >> 1];
      for (const channel of [0, 1, 2]) {
        const values = profile.map((column) => column.color[channel]);
        const center = median(values);
        expect(Math.max(...values.map((value) => Math.abs(value - center)))).toBeLessThan(6);
      }
    });
  });
}

// A hairline (ratio 0.5) is too faint for its 8-bit opacity to measure this.
for (const deviceScaleFactor of [1, 2]) {
  test.describe(`at device pixel ratio ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });

    test("a line keeps one intensity along its length at any slope", async ({ page }) => {
      // One row over twelve axes, its segments as steep as 0.14 to 4.2
      // pixels per pixel; the range rows run along the top and bottom.
      const line = [0.5, 0.45, 0.2, 0.9, 0.1, 0.6, 0.55, 0.58, 0.3, 0.95, 0.05, 0.5];
      const names = [...line.map((_, i) => `c${i}`), "k"];
      const rows = [
        [...line, 0],
        [...line.map(() => 0), 1],
        [...line.map(() => 1), 2],
      ];
      await uploadRows(page, names, rows, "k");
      // Per segment, the opacity summed across the line in each pixel column
      // (each pixel row where the line is steep), times the cosine (sine) of
      // its angle: the line's intensity per unit length, which exact pixel
      // coverage keeps whatever the line's offset between pixel centers. Its
      // coefficient of variation along the segment, clear of the axes.
      const variations = await page.evaluate(async () => {
        const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
          | (ParallelPlotHandle & CoverageProbe & BundleProbe)
          | null;
        let canvas = pp?.foreground_ref.current;
        if (!pp || !canvas) {
          throw new Error("No parallel plot");
        }
        pp.redrawLines();
        if (pp.exact !== null) {
          while (pp.exact.busy) await new Promise(requestAnimationFrame);
          canvas = pp.exact_image_ref.current;
          if (!canvas) throw new Error("No completed line surface");
        }
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext("2d");
        if (context === null) {
          throw new Error("No 2D context");
        }
        // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
        context.drawImage(canvas, 0, 0);
        const { data } = context.getImageData(0, 0, copy.width, copy.height);
        const alphaAt = (x: number, y: number) => data[(y * copy.width + x) * 4 + 3] / 255;
        const row = pp.props.rows_filtered[0];
        const ratio = pp.pixelRatio;
        const points = pp.state.dimensions.map((dimension) => [
          (pp.position(dimension) - pp.scrollLeft) * ratio,
          pp.yscale[dimension](row[dimension]) * ratio,
        ]);
        const result: { slope: number; variation: number }[] = [];
        for (let i = 1; i < points.length; ++i) {
          const [[x0, y0], [x1, y1]] = [points[i - 1], points[i]];
          const slope = (y1 - y0) / (x1 - x0);
          const steep = Math.abs(slope) > 1;
          // Across the line: rows of a column, or columns of a row.
          const [from, to] = steep ? [y0, y1] : [x0, x1];
          const projection = steep
            ? Math.abs(Math.sin(Math.atan(slope)))
            : Math.cos(Math.atan(slope));
          const sums: number[] = [];
          for (
            let along = Math.ceil(Math.min(from, to) + 0.15 * Math.abs(to - from));
            along < Math.max(from, to) - 0.15 * Math.abs(to - from);
            ++along
          ) {
            const center = steep
              ? x0 + (along + 0.5 - y0) / slope
              : y0 + (along + 0.5 - x0) * slope;
            let sum = 0;
            for (let across = Math.floor(center) - 4; across <= Math.ceil(center) + 4; ++across) {
              sum += steep ? alphaAt(across, along) : alphaAt(along, across);
            }
            sums.push(sum * projection);
          }
          const mean = sums.reduce((total, sum) => total + sum, 0) / sums.length;
          const variance = sums.reduce((total, sum) => total + (sum - mean) ** 2, 0) / sums.length;
          result.push({ slope, variation: Math.sqrt(variance) / mean });
        }
        return result;
      });
      expect(variations).toHaveLength(11);
      // Exact coverage varies by 0.25% at most before the canvas rounds each
      // pixel's opacity to 8 bits; a tent of coverage, by up to 6%.
      for (const { slope, variation } of variations) {
        expect({ slope, variation: variation < 0.02 }).toEqual({ slope, variation: true });
      }
    });
  });
}

/**
 * Thirty thousand rows fanning out from one point over a whole axis, and the
 * canvas's opacity along the middle of the fan from `from` to `to` of the way
 * from the point. The rows' density, and so the opacity, falls smoothly away
 * from the point, where every pixel is crossed by lines at all offsets.
 */
async function fanOpacities(page: Page, from: number, to: number): Promise<number[]> {
  const fan = Array.from({ length: 30000 }, (_, i) => [0, i / 29999, i / 29999]);
  await uploadRows(page, ["a", "b", "c"], [...fan, [1, 1, 1]], "c");
  return page.evaluate(
    async ({ from, to }) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
        | (ParallelPlotHandle & CoverageProbe)
        | null;
      if (!pp) {
        throw new Error("No parallel plot");
      }
      pp.redrawLines();
      while (pp.exact?.busy) await new Promise(requestAnimationFrame);
      const canvas = pp.exact === null ? pp.foreground_ref.current : pp.exact_image_ref.current;
      if (!canvas) throw new Error("No parallel line surface");
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) {
        throw new Error("No 2D context");
      }
      // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
      context.drawImage(canvas, 0, 0);
      const { data } = context.getImageData(0, 0, copy.width, copy.height);
      const ratio = pp.pixelRatio;
      const [xPoint, xEnd] = ["a", "b"].map(
        (dimension) => (pp.position(dimension) - pp.scrollLeft) * ratio,
      );
      const [yPoint, yEnd] = [pp.yscale.a(0) * ratio, pp.yscale.b(0.5) * ratio];
      const values: number[] = [];
      const steps = Math.ceil(Math.abs(xEnd - xPoint) * (to - from));
      for (let step = 0; step < steps; ++step) {
        const t = from + (step / steps) * (to - from);
        const [x, y] = [xPoint + t * (xEnd - xPoint), yPoint + t * (yEnd - yPoint)].map(Math.floor);
        values.push(data[(y * copy.width + x) * 4 + 3]);
      }
      return values;
    },
    { from, to },
  );
}

test("pixels crossed by lines at every offset are fully opaque", async ({ page }) => {
  // A one-pixel line covers at most 91% of a pixel at 45 degrees: taken as
  // is, dense regions of sloped lines never become opaque.
  const opacities = await fanOpacities(page, 0.01, 0.05);
  expect(Math.min(...opacities)).toBeGreaterThanOrEqual(254);
});

test("a smooth fade of density is dithered rather than banded", async ({ page }) => {
  const opacities = await fanOpacities(page, 0.2, 0.8);
  // The fade spans tens of 8-bit levels over hundreds of pixels. Rounded,
  // it holds each level over a run of pixels: a band. Dithered, neighbors
  // round either way and runs stay short.
  let runs = 1;
  for (let i = 1; i < opacities.length; ++i) {
    runs += opacities[i] === opacities[i - 1] ? 0 : 1;
  }
  expect(Math.max(...opacities) - Math.min(...opacities)).toBeGreaterThan(20);
  expect(opacities.length / runs).toBeLessThan(2.5);
});

for (const [mode, expected] of [
  ["mean", "the color map at their mean value"],
  ["lowest", "the lowest value's color"],
  ["highest", "the highest value's color"],
] as const) {
  test(`coincident lines of distant values show ${expected} in the ${mode} color mode`, async ({
    page,
  }) => {
    // Two coincident bundles colored by the ends of the color map. Their
    // colors average to a dull brown for viridis, which the map does not
    // have; their values average to its middle, a teal.
    const bundles = [0, 1].flatMap((value) => Array.from({ length: 100 }, () => [0, 3, value]));
    await uploadRows(page, ["a", "b", "c"], [...bundles, ...RANGE_ROWS], "c", { color_mode: mode });
    const profile = await segmentProfile(page);
    const target = await page.evaluate((mode) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
        | (ParallelPlotHandle & ColorProbe)
        | null;
      if (!pp) {
        throw new Error("No parallel plot");
      }
      const binning = pp.props.color_binning;
      const [low, high] = [0, 1].map((value) => binning.binOf(value));
      const bin = mode === "lowest" ? low : mode === "highest" ? high : (low + high) / 2;
      const [below, above] = [binning.palette[Math.floor(bin)], binning.palette[Math.ceil(bin)]];
      const fraction = bin - Math.floor(bin);
      return (["r", "g", "b"] as const).map(
        (channel) => below[channel] + fraction * (above[channel] - below[channel]),
      );
    }, mode);
    expect(profile.length).toBeGreaterThan(40);
    for (const column of profile) {
      for (const channel of [0, 1, 2]) {
        expect(Math.abs(column.color[channel] - target[channel])).toBeLessThan(8);
      }
    }
  });
}

for (const [mode, value] of [
  ["lowest", 0],
  ["highest", 1],
] as const) {
  test(`the Canvas 2D fallback draws the ${mode} values on top in the ${mode} color mode`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind: string,
        options?: unknown,
      ) {
        return kind === "webgl2" ? null : getContext.call(this, kind, options);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    // Coincident lines spread over both ends of the color map, a color bin
    // each: drawn in shuffled order, any of them could end up on top.
    const bundles = Array.from({ length: 100 }, (_, i) => [
      [0, 3, 0.3 * (i / 99)],
      [0, 3, 1 - 0.3 * (i / 99)],
    ]).flat();
    await uploadRows(page, ["a", "b", "c"], [...bundles, ...RANGE_ROWS], "c", { color_mode: mode });
    expect(await renderer(page)).toBe("canvas");
    const onTop = await page.evaluate((value) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
        | (ParallelPlotHandle & ColorProbe)
        | null;
      if (!pp) {
        throw new Error("No parallel plot");
      }
      const { r, g, b } = pp.props.color_binning.palette[pp.props.color_binning.binOf(value)];
      return [r, g, b];
    }, value);
    // Canvas 2D draws progressively: wait for the last frame. Its anti-aliased
    // edges let the other bundle show through in a few columns, so the
    // typical column is compared; each color bin is one translucent stroke,
    // so the values next to the end on top tint it a little.
    await expect
      .poll(async () => {
        const profile = await segmentProfile(page, { redraw: false });
        return Math.max(
          ...[0, 1, 2].map((channel) => {
            const values = profile.map((column) => column.color[channel]).sort((x, y) => x - y);
            return Math.abs(values[values.length >> 1] - onTop[channel]);
          }),
        );
      })
      .toBeLessThan(16);
  });
}

interface ColorProbe {
  props: {
    color_binning: {
      binOf: (value: number) => number;
      palette: ReadonlyArray<{ r: number; g: number; b: number }>;
    };
  };
}

/**
 * Rows that give the axes of `a` (0 to 1), `b` (0 to 10) and the color column
 * `c` (0 to 1, with enough distinct values to stay numeric) their ranges. In
 * either axis order none comes near the middle of the segment from a = 0 to
 * b = 3: they run along the top and bottom of the plot.
 */
const RANGE_ROWS = [
  [0, 0, 0],
  [1, 10, 0.25],
  [1, 10, 0.4],
  [1, 10, 0.6],
  [1, 10, 0.75],
  [1, 10, 1],
];

/**
 * Loads `rows` of the `names` columns from a CSV upload, colored by
 * `colorBy`, with straight lines and the saved page `state` given.
 */
async function uploadRows(
  page: Page,
  names: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  colorBy: string,
  state: Record<string, unknown> = {},
): Promise<void> {
  const saved = {
    "PARALLEL_PLOT.hide": ["uid", colorBy],
    "PARALLEL_PLOT.renderQuality": "full",
    color_by: colorBy,
    ...state,
  };
  const query = Object.entries(saved)
    .map(([key, value]) => `hip.${key}=${encodeURIComponent(JSON.stringify(value))}`)
    .join("&");
  await page.goto(`/?provider=upload&${query}`);
  await page.locator("input[type=file]").setInputFiles({
    name: "rows.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([names, ...rows].map((row) => row.join(",")).join("\n")),
  });
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
  await page.getByRole("button", { name: "Straight", exact: true }).click();
}

/** What the line canvas shows in one device pixel column across a segment. */
interface ColumnProfile {
  /** Opacity summed over the column's window around the segment. */
  alpha: number;
  /** Opacity-weighted mean color of the window, 0-255 per channel. */
  color: [number, number, number];
}

/**
 * Per device pixel column from `from` to `to` of the way along the segment
 * of the first row between the first two axes: what the canvas shows within
 * `radius` pixels of where the segment crosses the column, right after a
 * redraw (WebGL) or as the canvas stands (Canvas 2D, which draws over frames).
 */
async function segmentProfile(
  page: Page,
  { from = 0.1, to = 0.4, radius = 6, redraw = true } = {},
): Promise<ColumnProfile[]> {
  return page.evaluate(
    async ({ from, to, radius, redraw }) => {
      const pp = (window as unknown as HiPlotWindow).hiplot_last_instance?.parallelPlot() as
        | (ParallelPlotHandle & CoverageProbe & BundleProbe)
        | null;
      let canvas = pp?.foreground_ref.current;
      if (!pp || !canvas) {
        throw new Error("No parallel plot");
      }
      if (redraw) {
        pp.redrawLines();
        if (pp.exact !== null) {
          while (pp.exact.busy) await new Promise(requestAnimationFrame);
          canvas = pp.exact_image_ref.current;
          if (!canvas) throw new Error("No completed line surface");
        }
      }
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d");
      if (context === null) {
        throw new Error("No 2D context");
      }
      // Same task as the draw, so a WebGL buffer has not been presented and cleared yet.
      context.drawImage(canvas, 0, 0);
      const { data } = context.getImageData(0, 0, copy.width, copy.height);
      const [first, second] = pp.state.dimensions;
      const row = pp.props.rows_filtered[0];
      const ratio = pp.pixelRatio;
      const [x0, y0] = [
        (pp.position(first) - pp.scrollLeft) * ratio,
        pp.yscale[first](row[first]) * ratio,
      ];
      const [x1, y1] = [
        (pp.position(second) - pp.scrollLeft) * ratio,
        pp.yscale[second](row[second]) * ratio,
      ];
      const columns: ColumnProfile[] = [];
      for (let x = Math.ceil(x0 + from * (x1 - x0)); x < x0 + to * (x1 - x0); ++x) {
        const crossing = y0 + ((x + 0.5 - x0) / (x1 - x0)) * (y1 - y0);
        const column: ColumnProfile = { alpha: 0, color: [0, 0, 0] };
        for (let y = Math.floor(crossing) - radius; y <= Math.ceil(crossing) + radius; ++y) {
          const index = (y * copy.width + x) * 4;
          const alpha = data[index + 3] / 255;
          column.alpha += alpha;
          for (const channel of [0, 1, 2]) {
            column.color[channel] += data[index + channel] * alpha;
          }
        }
        column.color = column.color.map((sum) => sum / column.alpha) as [number, number, number];
        columns.push(column);
      }
      return columns;
    },
    { from, to, radius, redraw },
  );
}
