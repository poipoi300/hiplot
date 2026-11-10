import { describe, expect, test } from "bun:test";
import {
  type BinnedFrame,
  BinnedKernel,
  type BinnedRequest,
  buildPairHistogram,
  DEFAULT_AXIS_BINS,
  MAX_AXIS_BINS,
  MAX_RASTER_CELLS,
  quantizeColumn,
  rasterHistogram,
  rasterizeHistograms,
} from "./binned";
import type { LineColors } from "./webgl";

const palette = [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 100, g: 100, b: 100 },
];

function numericColors(bins: readonly number[]): LineColors {
  return { bins: new Uint32Array(bins), palette, colorMapBins: 2 };
}

function frame(overrides: Partial<BinnedFrame> = {}): BinnedFrame {
  return {
    width: 100,
    height: 100,
    lineWidth: 1,
    axes: [
      { column: 1, x: 20 },
      { column: 2, x: 80 },
    ],
    contextColor: { r: 0, g: 255, b: 0 },
    contextAlpha: 0.2,
    colorMode: "mean",
    ...overrides,
  };
}

function request(overrides: Partial<BinnedRequest> = {}): BinnedRequest {
  return {
    ...frame(),
    id: 1,
    columns: [
      { id: 1, pixels: new Float32Array([20.5, 20.5, 20.5]) },
      { id: 2, pixels: new Float32Array([20.5, 20.5, 20.5]) },
    ],
    selection: new Uint8Array([1, 1, 0]),
    colors: numericColors([0, 1, 2]),
    ...overrides,
  };
}

const sum = (values: Float64Array): number => values.reduce((total, value) => total + value, 0);
const rgbaAt = (pixels: Uint8ClampedArray, x: number, y: number, width = 100): number[] =>
  Array.from(pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4));

function sameHistogram(
  actual: ReturnType<typeof buildPairHistogram>,
  expected: ReturnType<typeof buildPairHistogram>,
): void {
  expect(actual.bins).toBe(expected.bins);
  for (const name of [
    "selected",
    "context",
    "selectedLeft",
    "selectedRight",
    "contextLeft",
    "contextRight",
    "color0",
    "color1",
    "color2",
    "minimum",
    "maximum",
  ] as const) {
    expect(Array.from(actual[name])).toEqual(Array.from(expected[name]));
  }
}

describe("all-row histograms", () => {
  test("pixel-scale bins retain endpoint and missing identities above 255", () => {
    expect(
      Array.from(quantizeColumn(new Float32Array([0, 255, 499, Number.NaN]), 500, 512)),
    ).toEqual([0, 255, 499, 500]);
  });
  test("quantization bounds storage and gives missing values a distinct bin", () => {
    const pixels = new Float32Array([-2, 0, 50, 100, 200, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(Array.from(quantizeColumn(pixels, 100, MAX_AXIS_BINS))).toEqual([
      0, 0, 50, 99, 99, 100, 100,
    ]);
    expect(Array.from(quantizeColumn(pixels, 100, 32))).toEqual([0, 0, 16, 31, 31, 32, 32]);
    expect(Array.from(quantizeColumn(new Float32Array([0, 2, Number.NaN]), 3))).toEqual([0, 2, 3]);
  });

  test("counts every row including both-missing geometry and conserves colors", () => {
    const left = new Float32Array([10, 10.2, Number.NaN, 50, Number.NaN]);
    const right = new Float32Array([80, 80.2, 20, Number.NaN, Number.NaN]);
    const counts = buildPairHistogram(
      left,
      right,
      new Uint8Array([1, 1, 1, 0, 1]),
      numericColors([0, 1, 2, 1, 0]),
      100,
    );
    expect(counts.selected.length).toBe((Math.min(100, DEFAULT_AXIS_BINS) + 1) ** 2);
    expect(sum(counts.selected)).toBe(4);
    expect(sum(counts.context)).toBe(1);
    expect(new Set(counts.cells).size).toBe(counts.cells.length);
    expect(counts.cells).not.toContain(counts.selected.length - 1);
    expect(sum(counts.color0)).toBe(1);
    expect(sum(counts.color1)).toBe(1);
    expect(sum(counts.selectedLeft)).toBeCloseTo(20.2);
    expect(sum(counts.selectedRight)).toBeCloseTo(180.2);
    const occupied = counts.selected.indexOf(2);
    expect(counts.minimum[occupied]).toBe(0);
    expect(counts.maximum[occupied]).toBe(1);
  });

  test("a brushed recount equals a fresh count and removes departed extrema", () => {
    const left = new Float32Array([20, 20.1, 20.2]);
    const right = new Float32Array([60, 60.1, 60.2]);
    const colors = numericColors([0, 1, 2]);
    const selection = new Uint8Array([1, 1, 0]);
    const before = buildPairHistogram(left, right, selection, colors, 100);
    selection.set([0, 1, 1]);
    const after = buildPairHistogram(left, right, selection, colors, 100);
    sameHistogram(
      after,
      buildPairHistogram(
        left.slice(),
        right.slice(),
        selection.slice(),
        numericColors([0, 1, 2]),
        100,
      ),
    );
    const cell = before.selected.indexOf(2);
    expect(before.minimum[cell]).toBe(0);
    expect(after.minimum[cell]).toBe(1);
    expect(after.maximum[cell]).toBe(1);
    expect(after.color1[cell]).toBe(1);
  });

  test("categorical sums retain weighted RGB rather than averaging cell colors", () => {
    const histogram = buildPairHistogram(
      new Float32Array([2, 2, 2]),
      new Float32Array([3, 3, 3]),
      new Uint8Array([1, 1, 1]),
      { ...numericColors([0, 0, 1]), colorMapBins: 0 },
      100,
    );
    expect(sum(histogram.color0)).toBe(2);
    expect(sum(histogram.color1)).toBe(0);
    expect(sum(histogram.color2)).toBe(1);
  });

  test("dense overlaps do not saturate integer counts or numeric color sums", () => {
    const rows = 20_000;
    const histogram = buildPairHistogram(
      new Float32Array(rows).fill(20),
      new Float32Array(rows).fill(40),
      new Uint8Array(rows).fill(1),
      { ...numericColors([]), bins: new Uint32Array(rows).fill(1) },
      100,
    );
    expect(sum(histogram.selected)).toBe(rows);
    expect(sum(histogram.color0)).toBe(rows);
  });

  test("mismatched row identities fail instead of silently dropping rows", () => {
    expect(() =>
      buildPairHistogram(
        new Float32Array(2),
        new Float32Array(3),
        new Uint8Array(2),
        numericColors([0, 1]),
        100,
      ),
    ).toThrow("same rows");
  });
});

function separatedPopulations(order: "alternating" | "grouped" | "shuffled"): BinnedRequest {
  const perGroup = 4096;
  const rows = perGroup * 2;
  const indices = Uint32Array.from({ length: rows }, (_, row) => row);
  if (order === "shuffled") {
    let seed = 20261110;
    for (let index = rows - 1; index > 0; --index) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const other = seed % (index + 1);
      [indices[index], indices[other]] = [indices[other], indices[index]];
    }
  }
  const left = new Float32Array(rows);
  const right = new Float32Array(rows);
  const bins = new Uint32Array(rows);
  for (let row = 0; row < rows; ++row) {
    const source = indices[row];
    const group = order === "alternating" ? source % 2 : Math.floor(source / perGroup);
    const member = order === "alternating" ? Math.floor(source / 2) : source % perGroup;
    left[row] = group * 128 + Math.floor(member / 64) + 0.5;
    right[row] = group * 128 + (member % 64) + 0.5;
    bins[row] = group;
  }
  return request({
    height: 256,
    columns: [
      { id: 1, pixels: left },
      { id: 2, pixels: right },
    ],
    selection: new Uint8Array(rows).fill(1),
    colors: { bins, palette, colorMapBins: 0 },
  });
}

describe("bounded density raster", () => {
  test("dense alternating populations both remain visible between the axes", () => {
    for (const selected of [true, false]) {
      const input = separatedPopulations("alternating");
      if (!selected) input.selection?.fill(0);
      const image = new BinnedKernel().render(input);
      const alpha = [0, 0];
      for (let group = 0; group < 2; ++group) {
        for (let y = group * 128; y < group * 128 + 64; ++y) {
          for (let x = 35; x < 65; ++x) {
            const pixel = rgbaAt(image.pixels, x, y);
            alpha[group] += pixel[3];
            if (selected && pixel[3] > 0) {
              expect(pixel[group === 0 ? 0 : 2]).toBe(255);
              expect(pixel[group === 0 ? 2 : 0]).toBe(0);
            }
          }
        }
      }
      expect(alpha[0]).toBeGreaterThan(10_000);
      expect(alpha[1]).toBeGreaterThan(10_000);
      expect(alpha[0]).toBeCloseTo(alpha[1], 0);
    }
  });

  test("dense aggregation keeps a one-row population in a separated endpoint region", () => {
    const population = 128 ** 2;
    const rows = population + 1;
    const left = Float32Array.from({ length: rows }, (_, row) => Math.floor(row / 128) + 0.5);
    const right = Float32Array.from({ length: rows }, (_, row) => (row % 128) + 0.5);
    left[population] = 225.5;
    right[population] = 225.5;
    const selection = new Uint8Array(rows).fill(1);
    const colors = { bins: new Uint32Array(rows), palette, colorMapBins: 0 };
    colors.bins[population] = 1;
    const input = request({
      height: 256,
      columns: [
        { id: 1, pixels: left },
        { id: 2, pixels: right },
      ],
      selection,
      colors,
    });
    const histogram = buildPairHistogram(left, right, selection, colors, 256);
    expect(histogram.cells.length).toBeGreaterThan(MAX_RASTER_CELLS);
    const image = new BinnedKernel().render(input);
    const rarePixel = rgbaAt(image.pixels, 50, 225);
    expect(rarePixel.slice(0, 3)).toEqual([0, 0, 255]);
    expect(rarePixel[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 50, 64)[3]).toBeGreaterThan(0);
  });

  test("dense raster pictures do not depend on input row permutations", () => {
    const reference = new BinnedKernel().render(separatedPopulations("alternating"));
    for (const order of ["grouped", "shuffled"] as const) {
      const candidate = new BinnedKernel().render(separatedPopulations(order));
      let maximumDifference = 0;
      for (let channel = 0; channel < reference.pixels.length; ++channel) {
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(reference.pixels[channel] - candidate.pixels[channel]),
        );
      }
      expect(maximumDifference).toBeLessThanOrEqual(1);
    }
  });

  test("spatial aggregation bounds raster cells and retains every statistic and missing identity", () => {
    const rows = 257 ** 2;
    const left = Float32Array.from({ length: rows }, (_, row) =>
      Math.floor(row / 257) === 256 ? Number.NaN : Math.floor(row / 257) + 0.5,
    );
    const right = Float32Array.from({ length: rows }, (_, row) =>
      row % 257 === 256 ? Number.NaN : (row % 257) + 0.5,
    );
    for (const colorMapBins of [0, 2]) {
      const histogram = buildPairHistogram(
        left,
        right,
        Uint8Array.from({ length: rows }, (_, row) => Number(row % 3 !== 0)),
        { ...numericColors(Array.from({ length: rows }, (_, row) => row % 3)), colorMapBins },
        256,
      );
      const raster = rasterHistogram(histogram);
      expect(raster.cells.length).toBeLessThanOrEqual(MAX_RASTER_CELLS);
      expect(raster.bins).toBeLessThan(histogram.bins);
      expect(rasterHistogram(raster)).toBe(raster);
      const expected = new Map<number, Record<string, number>>();
      for (let source = 0; source < histogram.selected.length; ++source) {
        const leftBin = Math.floor(source / 257);
        const rightBin = source % 257;
        const target =
          Math.floor((leftBin * raster.bins) / 256) * (raster.bins + 1) +
          Math.floor((rightBin * raster.bins) / 256);
        const statistics = expected.get(target) ?? {};
        for (const name of [
          "selected",
          "context",
          "selectedLeft",
          "selectedRight",
          "contextLeft",
          "contextRight",
          "color0",
          "color1",
          "color2",
        ] as const) {
          statistics[name] = (statistics[name] ?? 0) + histogram[name][source];
        }
        statistics.minimum = Math.min(statistics.minimum ?? Infinity, histogram.minimum[source]);
        statistics.maximum = Math.max(statistics.maximum ?? -Infinity, histogram.maximum[source]);
        expected.set(target, statistics);
      }
      for (const [cell, statistics] of expected) {
        for (const name of [
          "selected",
          "context",
          "selectedLeft",
          "selectedRight",
          "contextLeft",
          "contextRight",
          "color0",
          "color1",
          "color2",
          "minimum",
          "maximum",
        ] as const) {
          expect(raster[name][cell]).toBeCloseTo(statistics[name], 8);
        }
      }
      expect(sum(raster.selected)).toBe(sum(histogram.selected));
      expect(sum(raster.context)).toBe(sum(histogram.context));
      const bothMissing = raster.selected.length - 1;
      expect(raster.cells).not.toContain(bothMissing);
      expect(raster.selected[bothMissing]).toBe(histogram.selected[rows - 1]);
      expect(raster.context[bothMissing]).toBe(histogram.context[rows - 1]);
      const leftMissing = raster.cells.filter(
        (cell) => Math.floor(cell / (raster.bins + 1)) === raster.bins,
      );
      const rightMissing = raster.cells.filter((cell) => cell % (raster.bins + 1) === raster.bins);
      expect(leftMissing.length).toBeGreaterThan(0);
      expect(rightMissing.length).toBeGreaterThan(0);
    }
    const sparse = buildPairHistogram(
      new Float32Array([2, 2]),
      new Float32Array([3, 3]),
      new Uint8Array([1, 0]),
      numericColors([0, 1]),
      256,
    );
    expect(rasterHistogram(sparse)).toBe(sparse);
  });

  test("sample weights reproduce an equivalent dense population without scaling coverage peaks", () => {
    const sampled = new BinnedKernel().render(request({ rowWeight: 32 }));
    const repeated = new BinnedKernel().render(
      request({
        columns: [
          { id: 1, pixels: new Float32Array(96).fill(20.5) },
          { id: 2, pixels: new Float32Array(96).fill(20.5) },
        ],
        selection: Uint8Array.from({ length: 96 }, (_, row) => Number(row % 3 !== 2)),
        colors: numericColors(Array.from({ length: 96 }, (_, row) => row % 3)),
      }),
    );
    expect(Array.from(sampled.pixels)).toEqual(Array.from(repeated.pixels));
    expect(sampled.sourceRows).toBe(96);
    expect(sampled.sampledRows).toBe(3);
    expect(repeated.sourceRows).toBe(repeated.sampledRows);
  });
  test("numeric means and extrema select the same palette semantics", () => {
    const kernel = new BinnedKernel();
    const mean = kernel.render(request());
    const meanPixel = rgbaAt(mean.pixels, 50, 20);
    expect(meanPixel[0]).toBeCloseTo(meanPixel[2], 0);
    expect(meanPixel[1]).toBe(0);
    expect(meanPixel[3]).toBeGreaterThan(200);
    const lowest = kernel.render(
      request({ id: 2, columns: [], colors: undefined, selection: undefined, colorMode: "lowest" }),
    );
    expect(rgbaAt(lowest.pixels, 50, 20).slice(0, 3)).toEqual([255, 0, 0]);
    const highest = kernel.render(
      request({
        id: 3,
        columns: [],
        colors: undefined,
        selection: undefined,
        colorMode: "highest",
      }),
    );
    expect(rgbaAt(highest.pixels, 50, 20).slice(0, 3)).toEqual([0, 0, 255]);
    expect(rgbaAt(highest.pixels, 50, 30)).toEqual([0, 0, 0, 0]);
    expect(mean.width).toBe(100);
    expect(mean.height).toBe(100);
    expect(mean.milliseconds).toBeGreaterThanOrEqual(mean.countMs + mean.rasterMs - 0.001);
  });

  test("missing numeric colors remain gray and cannot win numeric extrema", () => {
    const kernel = new BinnedKernel();
    const image = kernel.render(
      request({ selection: new Uint8Array([0, 0, 1]), colorMode: "highest", contextAlpha: 0 }),
    );
    const pixel = rgbaAt(image.pixels, 50, 20);
    expect(pixel.slice(0, 3)).toEqual([100, 100, 100]);
    expect(pixel[3]).toBeGreaterThan(100);
  });

  test("categorical means weight rows and context remains below selected lines", () => {
    const kernel = new BinnedKernel();
    const categorical = kernel.render(
      request({
        selection: new Uint8Array([1, 1, 1]),
        colors: { ...numericColors([0, 0, 1]), colorMapBins: 0 },
      }),
    );
    expect(rgbaAt(categorical.pixels, 50, 20).slice(0, 3)).toEqual([170, 0, 85]);
    const context = kernel.render(
      request({ id: 2, columns: [], colors: undefined, selection: new Uint8Array([0, 0, 0]) }),
    );
    const pixel = rgbaAt(context.pixels, 50, 20);
    expect(pixel.slice(0, 3)).toEqual([0, 255, 0]);
    expect(pixel[3]).toBeGreaterThan(0);
    expect(pixel[3]).toBeLessThanOrEqual(51);
  });

  test("missing values produce stubs, both-missing pairs do not invent lines", () => {
    const kernel = new BinnedKernel();
    const image = kernel.render(
      request({
        columns: [
          { id: 1, pixels: new Float32Array([20.5]) },
          { id: 2, pixels: new Float32Array([Number.NaN]) },
        ],
        selection: new Uint8Array([1]),
        colors: numericColors([0]),
      }),
    );
    expect(rgbaAt(image.pixels, 10, 20)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 30, 20)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 50, 20)[3]).toBe(0);
    const missing = new BinnedKernel().render(
      request({
        columns: [
          { id: 1, pixels: new Float32Array([Number.NaN]) },
          { id: 2, pixels: new Float32Array([Number.NaN]) },
        ],
        selection: new Uint8Array([1]),
        colors: numericColors([0]),
      }),
    );
    expect(missing.pixels.every((value) => value === 0)).toBe(true);
  });

  test("half-resolution previews keep stubs at fifteen CSS pixels after enlargement", () => {
    const image = new BinnedKernel().render(
      request({
        width: 50,
        height: 50,
        lineWidth: 0.5,
        stubWidth: 7.5,
        axes: [{ column: 1, x: 20 }],
        columns: [{ id: 1, pixels: new Float32Array([15.25]) }],
        colors: numericColors([0]),
        selection: new Uint8Array([1]),
      }),
    );
    expect(rgbaAt(image.pixels, 13, 15, 50)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 26, 15, 50)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 11, 15, 50)[3]).toBe(0);
    expect(rgbaAt(image.pixels, 28, 15, 50)[3]).toBe(0);
  });

  test("a single axis retains its leading and trailing exact-width stubs", () => {
    const image = new BinnedKernel().render(
      request({
        axes: [{ column: 1, x: 40 }],
        columns: [{ id: 1, pixels: new Float32Array([30.5]) }],
        colors: numericColors([0]),
        selection: new Uint8Array([1]),
      }),
    );
    expect(rgbaAt(image.pixels, 30, 30)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 50, 30)[3]).toBeGreaterThan(0);
    expect(rgbaAt(image.pixels, 24, 30)[3]).toBe(0);
    expect(rgbaAt(image.pixels, 55, 30)[3]).toBe(0);
  });

  test("steep and reversed segments keep finite coverage and render inside the viewport", () => {
    const colors = numericColors([1]);
    const histogram = buildPairHistogram(
      new Float32Array([5]),
      new Float32Array([95]),
      new Uint8Array([1]),
      colors,
      100,
    );
    const output = rasterizeHistograms(
      frame(),
      [{ left: { column: 1, x: 40 }, right: { column: 2, x: 60 }, histogram }],
      colors,
      1,
      0,
    );
    expect(output.pixels.some((value) => value !== 0)).toBe(true);
    const reversed = rasterizeHistograms(
      frame(),
      [{ left: { column: 1, x: 60 }, right: { column: 2, x: 40 }, histogram }],
      colors,
      1,
      0,
    );
    expect(reversed.pixels.some((value) => value !== 0)).toBe(true);
    const invisible = rasterizeHistograms(
      frame(),
      [{ left: { column: 1, x: -100 }, right: { column: 2, x: -50 }, histogram }],
      colors,
      1,
      0,
    );
    expect(invisible.pixels.every((value) => value === 0)).toBe(true);
    const zero = rasterizeHistograms(
      frame(),
      [
        {
          left: { column: 1, x: 40 },
          right: { column: 2, x: 40 },
          histogram: buildPairHistogram(
            new Float32Array([50]),
            new Float32Array([50]),
            new Uint8Array([1]),
            colors,
            100,
          ),
        },
      ],
      colors,
      1,
      0,
    );
    expect(zero.pixels.every((value) => value === 0)).toBe(true);
  });

  test("resizing and empty datasets produce a correctly sized blank image", () => {
    const kernel = new BinnedKernel();
    kernel.render(request());
    const resized = kernel.render(
      request({
        id: 2,
        columns: [],
        selection: undefined,
        colors: undefined,
        height: 50,
        width: 40,
      }),
    );
    expect(resized.pixels.length).toBe(40 * 50 * 4);
    const empty = new BinnedKernel().render(
      request({
        columns: [],
        axes: [],
        selection: new Uint8Array(),
        colors: numericColors([]),
        width: 0,
        height: 0,
      }),
    );
    expect(Array.from(empty.pixels)).toEqual([0, 0, 0, 0]);
  });

  test("scrolling and order-only redraws reuse pair counts while brushing invalidates them", () => {
    const kernel = new BinnedKernel();
    kernel.render(request());
    const cache = (kernel as unknown as { pairs: Map<string, unknown> }).pairs;
    const pair = cache.get("1:2");
    kernel.render(
      request({
        id: 2,
        columns: [],
        selection: undefined,
        colors: undefined,
        axes: [
          { column: 1, x: -20 },
          { column: 2, x: 40 },
        ],
      }),
    );
    expect(cache.get("1:2")).toBe(pair);
    kernel.render(
      request({ id: 3, columns: [], selection: new Uint8Array([0, 1, 0]), colors: undefined }),
    );
    expect(cache.get("1:2")).not.toBe(pair);
    const fresh = new BinnedKernel().render(request({ selection: new Uint8Array([0, 1, 0]) }));
    const cached = kernel.render(
      request({ id: 4, columns: [], selection: undefined, colors: undefined }),
    );
    expect(Array.from(cached.pixels)).toEqual(Array.from(fresh.pixels));
    kernel.render(
      request({
        id: 5,
        columns: [],
        selection: undefined,
        colors: undefined,
        axes: [
          { column: 2, x: 20 },
          { column: 1, x: 80 },
        ],
      }),
    );
    expect(cache.has("1:2")).toBe(false);
    expect(cache.has("2:1")).toBe(true);
  });

  test("unknown geometry and uninitialized worker state fail visibly", () => {
    expect(() => new BinnedKernel().render(request({ selection: undefined }))).toThrow(
      "needs colors and selection",
    );
    expect(() => new BinnedKernel().render(request({ columns: [] }))).toThrow(
      "Unknown binned axis",
    );
  });
});
