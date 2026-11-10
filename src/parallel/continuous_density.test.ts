import { describe, expect, test } from "bun:test";
import {
  ContinuousDensityEvaluator,
  compositeContinuousPixel,
  continuousSparseIndex,
  continuousStripCoverage,
  DENSITY_TILE_ROWS,
  evaluateContinuousPairCPU,
  evaluateContinuousPixel,
} from "./continuous_density";
import {
  COLOR_CHANNEL_SCALE,
  type ContinuousHistogram,
  type ContinuousPair,
  type ContinuousRequest,
  type ContinuousUpdate,
  EMPTY_COLOR_KEY,
} from "./continuous_types";
import type { LineColors } from "./webgl";

const colors: LineColors = {
  bins: new Uint32Array([0, 1]),
  palette: [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 128, g: 128, b: 128 },
  ],
  colorMapBins: 2,
};

function histogram(bins = 9): ContinuousHistogram {
  const size = (bins + 1) ** 2;
  return {
    bins,
    selected: new Uint32Array(size),
    context: new Uint32Array(size),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    maximum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    occupied: new Uint32Array(),
    revision: 1,
  };
}

function populate(
  hist: ContinuousHistogram,
  left: number,
  right: number,
  selected: number,
  context = 0,
  rank = 0,
): void {
  const cell = left * (hist.bins + 1) + right;
  hist.selected[cell] = selected;
  hist.context[cell] = context;
  hist.color0[cell] = selected * rank;
  if (selected > 0) hist.minimum[cell] = hist.maximum[cell] = rank;
  hist.occupied = new Uint32Array([...hist.occupied, cell]);
}

function pair(hist = histogram(), key = "1:2", left = 0, right = 16): ContinuousPair {
  return { key, left: { column: 1, x: left }, right: { column: 2, x: right }, histogram: hist };
}

function frame(overrides: Partial<ContinuousRequest> = {}): ContinuousRequest {
  return {
    id: 1,
    columns: [],
    axes: [
      { column: 1, x: 0 },
      { column: 2, x: 16 },
    ],
    width: 16,
    height: 8,
    lineWidth: 1,
    pixelRatio: 1,
    curved: false,
    draft: false,
    resolution: 1,
    drawnRows: 2,
    selectedCount: 2,
    contextCount: 0,
    contextColor: { r: 0, g: 255, b: 0 },
    contextAlpha: 0.2,
    colorMode: "mean",
    ...overrides,
  };
}

function update(
  pairs: readonly ContinuousPair[],
  overrides: Partial<ContinuousUpdate> = {},
): ContinuousUpdate {
  return {
    pairs,
    colors,
    rows: 2,
    selectedCount: 2,
    contextCount: 0,
    changedRows: 0,
    countMs: 0,
    axisBins: pairs[0]?.histogram.bins ?? 9,
    ...overrides,
  };
}

const at = (pixels: Uint8ClampedArray, width: number, x: number, y: number): number[] =>
  Array.from(pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4));

describe("continuous pixel evaluation", () => {
  test("pixel-tile indices retain every intersecting sparse strip, including tile edges and stubs", () => {
    const hist = histogram(33);
    for (const [left, right] of [
      [0, 32],
      [32, 0],
      [8, 8],
      [16, 17],
      [33, 8],
      [24, 33],
      [33, 33],
    ])
      populate(hist, left, right, 1);
    const gap = 31;
    const height = 64;
    for (const curved of [false, true]) {
      for (const lineWidth of [0.25, 1, 3]) {
        const style = frame({ height, curved, lineWidth });
        const spatial = continuousSparseIndex(hist, style, gap, gap, height);
        expect(spatial.tiles).toBe(height / DENSITY_TILE_ROWS);
        expect(spatial.ranges.length).toBe(gap * spatial.tiles * 2);
        expect(spatial.indices.includes(33 * 34 + 33)).toBe(false);
        expect(spatial.indices.length).toBeLessThan(gap * spatial.tiles * hist.occupied.length);
        for (let x = 0; x < gap; ++x) {
          for (let y = 0; y < height; ++y) {
            const bucket = Math.floor(y / DENSITY_TILE_ROWS) * gap + x;
            const indexed = new Set(
              spatial.indices.subarray(spatial.ranges[bucket * 2], spatial.ranges[bucket * 2 + 1]),
            );
            for (const cell of hist.occupied) {
              const single = { ...hist, occupied: Uint32Array.of(cell) };
              if (evaluateContinuousPixel(single, style, gap, x + 0.5, y + 0.5).selected > 0) {
                expect(indexed.has(cell)).toBe(true);
              }
            }
          }
        }
      }
    }
    const empty = continuousSparseIndex(histogram(), frame(), 16, 16, 8);
    expect(empty.indices.length).toBe(0);
    expect(empty.ranges.every((value) => value === 0)).toBe(true);
  });

  test("exact strip coverage conserves area across offsets and handles level hairlines", () => {
    expect(continuousStripCoverage(0, 0, 1)).toBe(1);
    expect(continuousStripCoverage(0.5, 0, 1)).toBe(0.5);
    expect(continuousStripCoverage(1, 0, 1)).toBe(0);
    expect(continuousStripCoverage(0, 0, 0.25)).toBe(0.25);
    for (const slope of [0, 0.5, 1, 4]) {
      const totals = [0, 0.2, 0.5, 0.8].map((offset) => {
        let sum = 0;
        for (let y = -20; y < 20; ++y) sum += continuousStripCoverage(y + offset, slope, 1);
        return sum;
      });
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(1e-10);
    }
  });

  test("coincident bundles retain peak coverage rather than saturating antialiased edges", () => {
    const hist = histogram();
    populate(hist, 2, 2, 8192);
    const actual = evaluateContinuousPixel(hist, frame(), 16, 8, 2.25);
    expect(actual.selected).toBe(8192 * 0.75);
    expect(actual.selectedPeak).toBe(0.75);
    const rgba = compositeContinuousPixel(actual, frame(), colors, 8192, 0);
    expect(rgba[0]).toBe(1);
    expect(rgba[3]).toBeLessThanOrEqual(0.75);
    expect(rgba[3]).toBeGreaterThan(0.5);
  });

  test("sparse evaluation includes every occupied cell and is independent of occupied ordering", () => {
    const hist = histogram(33);
    for (let endpoint = 0; endpoint < 33; ++endpoint)
      populate(hist, endpoint, endpoint, 1, 0, endpoint % 2);
    const style = frame({ height: 32 });
    const before = Array.from({ length: 33 }, (_, y) =>
      evaluateContinuousPixel(hist, style, 16, 8, y),
    );
    expect(before.every((pixel) => pixel.selected === 1)).toBe(true);
    hist.occupied.reverse();
    expect(
      Array.from({ length: 33 }, (_, y) => evaluateContinuousPixel(hist, style, 16, 8, y)),
    ).toEqual(before);
  });

  test("missing endpoints draw only finite-endpoint stubs and both-missing cells never draw", () => {
    const hist = histogram();
    populate(hist, 9, 2, 2);
    populate(hist, 6, 9, 3);
    populate(hist, 9, 9, 100);
    const style = frame();
    expect(evaluateContinuousPixel(hist, style, 60, 44, 2).selected).toBe(0);
    expect(evaluateContinuousPixel(hist, style, 60, 45, 2).selected).toBe(2);
    expect(evaluateContinuousPixel(hist, style, 60, 14, 6).selected).toBe(3);
    expect(evaluateContinuousPixel(hist, style, 60, 15, 6).selected).toBe(0);
    for (const sparse of [true, false]) {
      expect(evaluateContinuousPixel(hist, style, 60, 30, 4, sparse).selected).toBe(0);
    }
  });

  test("mean numeric colors use raw rank sums and missing-color shares", () => {
    const hist = histogram();
    populate(hist, 2, 2, 4, 0, 0);
    const cell = 2 * 10 + 2;
    hist.color0[cell] = 1;
    hist.color1[cell] = 2;
    const pixel = evaluateContinuousPixel(hist, frame(), 16, 8, 2);
    const rgba = compositeContinuousPixel(pixel, frame(), colors, 4, 0);
    expect(rgba[0]).toBeCloseTo(127.75 / 255);
    expect(rgba[1]).toBeCloseTo(64 / 255);
    expect(rgba[2]).toBeCloseTo(127.75 / 255);
  });

  test("RGB fixed-point sums decode independently of density and numeric ranks", () => {
    const hist = histogram();
    populate(hist, 2, 2, 10);
    const cell = 22;
    hist.color0[cell] = 10 * COLOR_CHANNEL_SCALE;
    hist.color1[cell] = 0;
    hist.color2[cell] = 5 * COLOR_CHANNEL_SCALE;
    const pixel = evaluateContinuousPixel(hist, frame(), 16, 8, 2);
    const rgba = compositeContinuousPixel(pixel, frame(), { ...colors, colorMapBins: 0 }, 10, 0);
    expect(rgba.slice(0, 3)).toEqual([1, 0, 0.5]);
  });

  test("lowest/highest keep an actual integer extreme, never an interpolated key", () => {
    const hist = histogram();
    populate(hist, 2, 2, 1, 0, 0);
    populate(hist, 1, 3, 1, 0, 1);
    for (const sparse of [true, false]) {
      const low = evaluateContinuousPixel(hist, frame({ colorMode: "lowest" }), 16, 8, 2, sparse);
      const high = evaluateContinuousPixel(hist, frame({ colorMode: "highest" }), 16, 8, 2, sparse);
      expect(low.winner).toBe(0);
      expect(high.winner).toBe(1);
      expect(compositeContinuousPixel(low, frame({ colorMode: "lowest" }), colors, 2, 0)[0]).toBe(
        1,
      );
      expect(compositeContinuousPixel(high, frame({ colorMode: "highest" }), colors, 2, 0)[2]).toBe(
        1,
      );
    }
  });

  test("missing colors never win extrema and context never changes selected colors", () => {
    const hist = histogram();
    populate(hist, 2, 2, 2, 20, 1);
    const cell = 22;
    hist.color0[cell] = 1;
    hist.color1[cell] = 1;
    for (const colorMode of ["lowest", "highest"] as const) {
      const pixel = evaluateContinuousPixel(hist, frame({ colorMode }), 16, 8, 2);
      expect(pixel.winner).toBe(1);
      const rgba = compositeContinuousPixel(pixel, frame({ colorMode }), colors, 2, 20);
      expect(rgba[2]).toBeGreaterThan(rgba[1]);
    }
  });

  test("dense integration conditions both halves symmetrically for straight and eased curves", () => {
    const hist = histogram(33);
    for (let left = 0; left < 33; ++left) {
      for (let right = 0; right < 33; ++right) populate(hist, left, right, 1);
    }
    for (const curved of [false, true]) {
      const style = frame({ height: 32, curved });
      for (const x of [0.01, 2, 7.99]) {
        const left = evaluateContinuousPixel(hist, style, 16, x, 16, false);
        const right = evaluateContinuousPixel(hist, style, 16, 16 - x, 16, false);
        expect(left.selected).toBeGreaterThan(0);
        expect(left.selected).toBeCloseTo(right.selected, 8);
        expect(left.selectedPeak).toBeCloseTo(right.selectedPeak, 8);
      }
    }
  });

  test("eased curves change pair-local geometry but not row weights", () => {
    const hist = histogram();
    populate(hist, 0, 8, 5);
    const linear = evaluateContinuousPixel(hist, frame(), 16, 4, 2);
    const curved = evaluateContinuousPixel(hist, frame({ curved: true }), 16, 4, 1.25);
    expect(linear.selected).toBe(5);
    expect(curved.selected).toBe(5);
  });

  test("CPU images are top-down unpremultiplied RGBA8", () => {
    const hist = histogram();
    populate(hist, 1, 1, 1);
    const source = pair(hist);
    const image = evaluateContinuousPairCPU(source, frame(), update([source]));
    expect(at(image.pixels, image.width, 8, 0)).toEqual([255, 0, 0, 64]);
    expect(at(image.pixels, image.width, 8, 7)).toEqual([0, 0, 0, 0]);
  });
});

describe("continuous pair image cache", () => {
  test("scroll only composites cached pairs, including pairs initially offscreen", () => {
    const hist = histogram();
    populate(hist, 2, 2, 2);
    const evaluator = new ContinuousDensityEvaluator({ gl: null });
    const initialPairs = [pair(hist), pair(hist, "2:3", 16, 32)];
    const first = evaluator.render(frame(), update(initialPairs));
    expect(first.evaluatedPairs).toBe(2);
    expect(first.evaluatedColumns).toBe(32);
    const moved = initialPairs.map((source) => ({
      ...source,
      left: { ...source.left, x: source.left.x - 16 },
      right: { ...source.right, x: source.right.x - 16 },
    }));
    const scrolled = evaluator.render(frame(), update(moved));
    expect(scrolled.evaluatedPairs).toBe(0);
    expect(scrolled.evaluatedColumns).toBe(0);
    expect(scrolled.pixels).toEqual(first.pixels);
    expect(scrolled.rows).toBe(2);
    evaluator.dispose();
  });

  test("fractional scroll translations cannot invalidate local geometry through cancellation noise", () => {
    const hist = histogram();
    populate(hist, 2, 2, 2);
    const evaluator = new ContinuousDensityEvaluator({ gl: null });
    const source = pair(hist, "fractional", 0.1, 16.2);
    evaluator.render(frame(), update([source]));
    const shifted = {
      ...source,
      left: { ...source.left, x: source.left.x - 100 },
      right: { ...source.right, x: source.right.x - 100 },
    };
    expect(evaluator.render(frame(), update([shifted])).evaluatedPairs).toBe(0);
    evaluator.dispose();
  });

  test("local revisions invalidate only the affected pair and global references invalidate all", () => {
    const firstHistogram = histogram();
    const secondHistogram = histogram();
    populate(firstHistogram, 2, 2, 1);
    populate(secondHistogram, 4, 4, 1);
    const pairs = [pair(firstHistogram), pair(secondHistogram, "2:3", 16, 32)];
    const evaluator = new ContinuousDensityEvaluator({ gl: null });
    evaluator.render(frame(), update(pairs));
    firstHistogram.revision++;
    expect(evaluator.render(frame(), update(pairs)).evaluatedPairs).toBe(1);
    expect(evaluator.render(frame(), update(pairs)).evaluatedPairs).toBe(0);
    expect(evaluator.render(frame(), update(pairs, { selectedCount: 100 })).evaluatedPairs).toBe(2);
    expect(
      evaluator.render(frame({ curved: true }), update(pairs, { selectedCount: 100 }))
        .evaluatedPairs,
    ).toBe(2);
    evaluator.dispose();
  });

  test("dense software gestures reduce columns, never rows, then refine full width on release", () => {
    const hist = histogram(25);
    for (let left = 0; left < 25; ++left) {
      for (let right = 0; right < 25; ++right) populate(hist, left, right, 1);
    }
    const pairs = [pair(hist)];
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const draft = evaluator.render(frame({ draft: true }), update(pairs, { rows: 1_000_000 }));
    expect(draft.rows).toBe(1_000_000);
    expect(draft.evaluatedColumns).toBe(1);
    expect(evaluator.render(frame(), update(pairs)).evaluatedColumns).toBe(16);
    const hardware = new ContinuousDensityEvaluator({ gl: null, software: false });
    expect(hardware.render(frame({ draft: true }), update(pairs)).evaluatedColumns).toBe(16);
    evaluator.dispose();
    hardware.dispose();
  });

  test("sparse software gestures retain full columns and do not blur narrow bundles", () => {
    const hist = histogram();
    populate(hist, 0, 8, 8192);
    const pairs = [pair(hist)];
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const draft = evaluator.render(frame({ draft: true }), update(pairs));
    expect(draft.evaluatedColumns).toBe(16);
    const released = evaluator.render(frame(), update(pairs));
    expect(released.evaluatedPairs).toBe(0);
    expect(released.pixels).toEqual(draft.pixels);
    evaluator.dispose();
  });

  test("palette, width, height and context style changes invalidate retained pixels", () => {
    const hist = histogram();
    populate(hist, 2, 2, 1);
    const source = pair(hist);
    const evaluator = new ContinuousDensityEvaluator({ gl: null });
    evaluator.render(frame(), update([source]));
    const changedColors = { ...colors, palette: colors.palette.map((rgb) => ({ ...rgb })) };
    expect(
      evaluator.render(frame(), update([source], { colors: changedColors })).evaluatedPairs,
    ).toBe(1);
    expect(
      evaluator.render(frame({ height: 9 }), update([source], { colors: changedColors }))
        .evaluatedPairs,
    ).toBe(1);
    expect(
      evaluator.render(
        frame({ height: 9, contextAlpha: 0.5 }),
        update([source], { colors: changedColors }),
      ).evaluatedPairs,
    ).toBe(1);
    const widened = { ...source, right: { ...source.right, x: 20 } };
    expect(
      evaluator.render(
        frame({ height: 9, contextAlpha: 0.5 }),
        update([widened], { colors: changedColors }),
      ).evaluatedColumns,
    ).toBe(20);
    evaluator.dispose();
  });
});
