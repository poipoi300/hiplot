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

function denseContextHistogram(): ContinuousHistogram {
  const hist = histogram(256);
  const occupied: number[] = [];
  for (let left = 200; left < 256; ++left) {
    for (let right = 200; right < 256; ++right) {
      const cell = left * 257 + right;
      hist.context[cell] = 1;
      occupied.push(cell);
    }
  }
  hist.occupied = Uint32Array.from(occupied);
  return hist;
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
  test("production sparse CPU evaluation prunes disjoint cells with the existing tile index", () => {
    const hist = histogram(256);
    for (let left = 200; left < 212; ++left) {
      for (let right = 200; right < 225; ++right) populate(hist, left, right, 1);
    }
    const occupied = hist.occupied;
    let visits = 0;
    hist.occupied = new Proxy(occupied, {
      get(target, key) {
        if (key === Symbol.iterator)
          return function* () {
            for (const cell of target) {
              visits++;
              yield cell;
            }
          };
        if (typeof key === "string" && /^\d+$/.test(key)) visits++;
        return Reflect.get(target, key, target);
      },
    });
    const style = frame({ width: 85, height: 255, contextAlpha: 0 });
    const state = update([], { selectedCount: 300, rows: 300 });
    let floorCalls = 0;
    const originalFloor = Math.floor;
    let image: ReturnType<typeof evaluateContinuousPairCPU>;
    try {
      // Each strip examination floors its encoded left endpoint. Count index/bucket overhead too.
      Math.floor = (value) => {
        floorCalls++;
        return originalFloor(value);
      };
      image = evaluateContinuousPairCPU(pair(hist, "sparse-cpu", 0, 85), style, state);
    } finally {
      Math.floor = originalFloor;
    }
    expect(visits).toBeLessThan((85 * 255 * 300) / 16);
    expect(floorCalls).toBeLessThan((85 * 255 * 300) / 8);
    expect(image.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    const reference = { ...hist, occupied };
    for (let x = 0; x < 85; x += 13) {
      for (let y = 0; y < 255; y += 17) {
        const pixel = evaluateContinuousPixel(reference, style, 85, x + 0.5, y + 0.5);
        const rgba = compositeContinuousPixel(pixel, style, colors, 300, 0);
        expect(at(image.pixels, 85, x, y)).toEqual(
          Array.from(Uint8ClampedArray.from(rgba, (value) => value * 255)),
        );
      }
    }
  });

  test("dense endpoint integration retains isolated strands at pixel-height spacing", () => {
    const hist = denseContextHistogram();
    populate(hist, 64, 64, 1);
    const style = frame({ height: 255, contextAlpha: 0 });
    const reference = evaluateContinuousPixel(hist, style, 85, 42.5, 64.5, true);
    const dense = evaluateContinuousPixel(hist, style, 85, 42.5, 64.5, false);
    expect(reference.selected).toBe(0.5);
    expect(dense.selected).toBeCloseTo(reference.selected, 8);
    const image = evaluateContinuousPairCPU(
      pair(hist, "1:2", 0, 85),
      style,
      update([], { selectedCount: 1 }),
    );
    for (let x = 0; x < image.width; ++x) {
      expect(image.pixels[(64 * image.width + x) * 4 + 3]).toBeGreaterThan(0);
    }
  });
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

  test("dense peak coverage includes sub-bin positions at axis-adjacent pixels", () => {
    const hist = histogram(33);
    for (let left = 0; left < 33; ++left) {
      for (let right = 0; right < 33; ++right) populate(hist, left, right, 1);
    }
    const style = frame({ height: 32, curved: true });
    for (const x of [0.01, 0.1, 15.9, 15.99]) {
      for (const y of [15.25, 15.5, 15.75, 16]) {
        const pixel = evaluateContinuousPixel(hist, style, 16, x, y, false);
        expect(pixel.selectedPeak).toBeCloseTo(1, 6);
      }
    }
  });

  test("Bezier curves change pair-local geometry but not row weights", () => {
    const hist = histogram();
    populate(hist, 0, 8, 5);
    const linear = evaluateContinuousPixel(hist, frame(), 16, 4, 2);
    // Independent parametric sample at s=1/4: x=19/64 and y=5/32.
    const curved = evaluateContinuousPixel(hist, frame({ curved: true }), 16, 4.75, 1.25);
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

  test("hardware context loss switches dense drafts to the CPU column budget", () => {
    const hist = histogram(25);
    for (let left = 0; left < 25; ++left) {
      for (let right = 0; right < 25; ++right) populate(hist, left, right, 1);
    }
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: false });
    let disposed = false;
    (evaluator as unknown as { gpu: { contextLost: boolean; dispose: () => void } }).gpu = {
      contextLost: true,
      dispose: () => {
        disposed = true;
      },
    };
    const image = evaluator.render(frame({ draft: true }), update([pair(hist)]));
    expect(disposed).toBe(true);
    expect(image.evaluatedColumns).toBe(1);
    expect(image.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
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

  test("six-column gestures follow the idle brush envelope within two pixels", () => {
    const bins = 129;
    const hist = histogram(bins);
    const occupied: number[] = [];
    let selectedCount = 0;
    let contextCount = 0;
    for (let left = 0; left < bins; ++left) {
      for (let right = 0; right < bins; ++right) {
        const cell = left * (bins + 1) + right;
        occupied.push(cell);
        if (left >= 26 && left <= 83) {
          hist.selected[cell] = 100;
          hist.minimum[cell] = hist.maximum[cell] = 0;
          selectedCount += 100;
        } else {
          hist.context[cell] = 100;
          contextCount += 100;
        }
      }
    }
    hist.occupied = Uint32Array.from(occupied);
    const pairs = [pair(hist, "brushed", 0, 85)];
    const state = update(pairs, {
      selectedCount,
      contextCount,
      rows: selectedCount + contextCount,
    });
    for (const curved of [false, true]) {
      const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
      const style = frame({ width: 85, height: 128, curved });
      const gesture = evaluator.render({ ...style, draft: true }, state);
      const idle = evaluator.render(style, state);
      expect(gesture.evaluatedColumns).toBe(6);
      let absolute = 0;
      let energy = 0;
      let maximumBoundaryShift = 0;
      for (let x = 0; x < idle.width; ++x) {
        let gestureBoundary = -1;
        let idleBoundary = -1;
        for (let y = 0; y < idle.height; ++y) {
          const offset = (y * idle.width + x) * 4;
          if (gestureBoundary < 0 && gesture.pixels[offset] * gesture.pixels[offset + 3] > 6000)
            gestureBoundary = y;
          if (idleBoundary < 0 && idle.pixels[offset] * idle.pixels[offset + 3] > 6000)
            idleBoundary = y;
          for (let channel = 0; channel < 4; ++channel) {
            const reference =
              channel === 3
                ? idle.pixels[offset + 3]
                : (idle.pixels[offset + channel] * idle.pixels[offset + 3]) / 255;
            const candidate =
              channel === 3
                ? gesture.pixels[offset + 3]
                : (gesture.pixels[offset + channel] * gesture.pixels[offset + 3]) / 255;
            absolute += Math.abs(candidate - reference);
            energy += reference;
          }
        }
        expect(gestureBoundary).toBeGreaterThanOrEqual(0);
        expect(idleBoundary).toBeGreaterThanOrEqual(0);
        maximumBoundaryShift = Math.max(
          maximumBoundaryShift,
          Math.abs(gestureBoundary - idleBoundary),
        );
      }
      expect(absolute / energy).toBeLessThan(0.012);
      expect(maximumBoundaryShift).toBeLessThanOrEqual(2);
      evaluator.dispose();
    }
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

  test("reduced columns never extend missing-coordinate stubs beyond support", () => {
    for (const missingLeft of [false, true]) {
      const hist = denseContextHistogram();
      populate(hist, missingLeft ? 256 : 64, missingLeft ? 64 : 256, 1000);
      const pairs = [pair(hist, "missing-stub", 0, 85)];
      const state = update(pairs, { selectedCount: 1000, contextCount: 3136, rows: 4136 });
      const style = frame({ width: 85, height: 255, contextAlpha: 0 });
      const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
      const gesture = evaluator.render({ ...style, draft: true }, state);
      const idle = evaluator.render(style, state);
      const unsupportedX = missingLeft ? 66 : 18;
      expect(at(idle.pixels, 85, unsupportedX, 64)[3]).toBe(0);
      expect(at(gesture.pixels, 85, unsupportedX, 64)[3]).toBe(0);
      expect(at(gesture.pixels, 85, missingLeft ? 80 : 4, 64)[3]).toBeGreaterThan(0);
      evaluator.dispose();
    }
  });

  test("unresolved crossing footprints refine instead of expanding a false band", () => {
    const hist = denseContextHistogram();
    populate(hist, 0, 255, 1000);
    populate(hist, 87, 0, 1000);
    const pairs = [pair(hist, "near-crossing", 0, 32)];
    const state = update(pairs, { selectedCount: 2000, contextCount: 3136, rows: 5136 });
    const style = frame({ width: 32, height: 255, contextAlpha: 0 });
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const gesture = evaluator.render({ ...style, draft: true }, state);
    const idle = evaluator.render(style, state);
    expect(at(idle.pixels, 32, 1, 30)[3]).toBe(0);
    expect(at(gesture.pixels, 32, 1, 30)[3]).toBe(0);
    expect(gesture.pixels).toEqual(idle.pixels);
    for (const [x, y] of [
      [1, 12],
      [1, 83],
      [8, 67],
    ]) {
      expect(at(gesture.pixels, 32, x, y)[3]).toBeGreaterThan(0);
    }
    evaluator.dispose();
  });

  test("a crossing source column cannot inflate into a filled selected band", () => {
    const hist = denseContextHistogram();
    populate(hist, 0, 255, 1000);
    populate(hist, 255, 0, 1000);
    const pairs = [pair(hist, "crossing", 0, 80)];
    const state = update(pairs, { selectedCount: 2000, contextCount: 3136, rows: 5136 });
    const style = frame({ width: 80, height: 255, contextAlpha: 0 });
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const gesture = evaluator.render({ ...style, draft: true }, state);
    const idle = evaluator.render(style, state);
    expect(at(idle.pixels, 80, 32, 120)[3]).toBe(0);
    expect(at(gesture.pixels, 80, 32, 120)[3]).toBe(0);
    for (const [x, y] of [
      [16, 52],
      [16, 202],
      [39, 127],
    ]) {
      expect(at(idle.pixels, 80, x, y)[3]).toBeGreaterThan(0);
      expect(at(gesture.pixels, 80, x, y)[3]).toBeGreaterThan(0);
    }
    evaluator.dispose();
  });

  test("stationary context remains visible beside a moving selected strand", () => {
    const hist = denseContextHistogram();
    populate(hist, 0, 255, 1000);
    populate(hist, 56, 56, 0, 10_000);
    const pairs = [pair(hist, "independent-context", 0, 32)];
    const state = update(pairs, { selectedCount: 1000, contextCount: 13_136, rows: 14_136 });
    const style = frame({ width: 32, height: 255 });
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const gesture = evaluator.render({ ...style, draft: true }, state);
    const idle = evaluator.render(style, state);
    expect(at(idle.pixels, 32, 15, 56)[3]).toBeGreaterThan(0);
    expect(at(gesture.pixels, 32, 15, 56)[3]).toBeGreaterThan(0);
    expect(at(gesture.pixels, 32, 15, 56).slice(0, 3)).toEqual([0, 255, 0]);
    evaluator.dispose();
  });

  test("changed grids discard old gesture pixels and their support guides", () => {
    const hist = histogram(25);
    const occupied: number[] = [];
    const fill = (first: number): void => {
      for (let left = 0; left < 25; ++left) {
        for (let right = 0; right < 25; ++right) {
          const cell = left * 26 + right;
          hist.selected[cell] = Number(left >= first && left < first + 12);
          hist.context[cell] = 1 - hist.selected[cell];
          if (occupied.length < 625) occupied.push(cell);
        }
      }
    };
    fill(3);
    hist.occupied = Uint32Array.from(occupied);
    const pairs = [pair(hist, "moving", 0, 85)];
    const state = update(pairs, { rows: 625, selectedCount: 300, contextCount: 325 });
    const style = frame({ width: 85, height: 24, draft: true });
    const evaluator = new ContinuousDensityEvaluator({ gl: null, software: true });
    const first = evaluator.render(style, state);
    expect(evaluator.render(style, state).evaluatedPairs).toBe(0);
    fill(10);
    hist.revision++;
    const moved = evaluator.render(style, state);
    const fresh = new ContinuousDensityEvaluator({ gl: null, software: true });
    expect(moved.evaluatedPairs).toBe(1);
    expect(moved.pixels).not.toEqual(first.pixels);
    expect(moved.pixels).toEqual(fresh.render(style, state).pixels);
    evaluator.dispose();
    fresh.dispose();
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
