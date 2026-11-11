import { describe, expect, test } from "bun:test";
import { ContinuousKernel } from "./continuous_grid";
import {
  COLOR_CHANNEL_SCALE,
  type ContinuousHistogram,
  type ContinuousRequest,
  type ContinuousUpdate,
  EMPTY_COLOR_KEY,
  MAX_DENSITY_BINS,
  MIN_DENSITY_BINS,
} from "./continuous_types";
import type { LineColors } from "./webgl";

const palette = [
  { r: 12.5, g: 47, b: 255 },
  { r: 201, g: 255, b: 16 },
  { r: 98, g: 100.25, b: 102 },
  { r: 255, g: 0, b: 127.5 },
  { r: 117, g: 117, b: 117 },
];

function request(overrides: Partial<ContinuousRequest> = {}): ContinuousRequest {
  return {
    id: 1,
    width: 100,
    height: 100,
    lineWidth: 1,
    pixelRatio: 1,
    curved: false,
    draft: false,
    resolution: 1,
    drawnRows: 0,
    selectedCount: 0,
    contextCount: 0,
    contextColor: { r: 100, g: 100, b: 100 },
    contextAlpha: 0.2,
    colorMode: "mean",
    axes: [
      { column: 1, x: 20 },
      { column: 2, x: 80 },
    ],
    columns: [
      { id: 1, pixels: new Float32Array([20, 20, 20, Number.NaN, Number.NaN]) },
      { id: 2, pixels: new Float32Array([70, 70, Number.NaN, 70, Number.NaN]) },
    ],
    selection: new Uint8Array([1, 1, 0, 1, 1]),
    colors: { bins: new Uint32Array([0, 3, 2, 4, 1]), palette, colorMapBins: 4 },
    ...overrides,
  };
}

function cachedRequest(
  initial: ContinuousRequest,
  overrides: Partial<ContinuousRequest> = {},
): ContinuousRequest {
  return { ...initial, columns: [], colors: undefined, selection: undefined, ...overrides };
}

const statistics = [
  "selected",
  "context",
  "color0",
  "color1",
  "color2",
  "minimum",
  "maximum",
  "occupied",
] as const;

function sameHistogram(actual: ContinuousHistogram, expected: ContinuousHistogram): void {
  expect(actual.bins).toBe(expected.bins);
  for (const name of statistics) expect(actual[name]).toEqual(expected[name]);
}

function total(values: Iterable<number>): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}

/** Independent all-row reference: no retained cells, masks, extrema or geometry. */
function scratch(
  input: ContinuousRequest,
  leftColumn: number,
  rightColumn: number,
): ContinuousHistogram & { minimumCount: Uint32Array; maximumCount: Uint32Array } {
  const colors = input.colors;
  const selection = input.selection;
  if (colors === undefined || selection === undefined)
    throw new Error("Incomplete reference input");
  const bins = Math.min(MAX_DENSITY_BINS, Math.max(MIN_DENSITY_BINS, Math.ceil(input.height)));
  const size = (bins + 1) ** 2;
  const histogram: ContinuousHistogram = {
    bins,
    selected: new Uint32Array(size),
    context: new Uint32Array(size),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    maximum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    occupied: new Uint32Array(),
    revision: 0,
  };
  const left = input.columns.find(({ id }) => id === leftColumn)?.pixels;
  const right = input.columns.find(({ id }) => id === rightColumn)?.pixels;
  const endpoint = (pixel: number | undefined): number => {
    if (pixel === undefined || !Number.isFinite(pixel)) return bins;
    if (pixel <= 0) return 0;
    if (pixel >= input.height) return bins - 1;
    return Math.floor((pixel * (bins - 1)) / input.height + 0.5);
  };
  const occupied = new Set<number>();
  for (let row = 0; row < selection.length; ++row) {
    const cell = endpoint(left?.[row]) * (bins + 1) + endpoint(right?.[row]);
    occupied.add(cell);
    if (selection[row] === 0) {
      histogram.context[cell] += 1;
      continue;
    }
    histogram.selected[cell] += 1;
    const rank = colors.bins[row];
    if (colors.colorMapBins === 0) {
      const { r, g, b } = colors.palette[rank];
      histogram.color0[cell] += Math.round((r / 255) * COLOR_CHANNEL_SCALE);
      histogram.color1[cell] += Math.round((g / 255) * COLOR_CHANNEL_SCALE);
      histogram.color2[cell] += Math.round((b / 255) * COLOR_CHANNEL_SCALE);
    } else if (rank === colors.colorMapBins) {
      histogram.color1[cell] += 1;
    } else {
      histogram.color0[cell] += rank;
      histogram.minimum[cell] = Math.min(histogram.minimum[cell], rank);
      histogram.maximum[cell] =
        histogram.maximum[cell] === EMPTY_COLOR_KEY
          ? rank
          : Math.max(histogram.maximum[cell], rank);
    }
  }
  histogram.occupied = Uint32Array.from([...occupied].sort((a, b) => a - b));
  const minimumCount = new Uint32Array(size);
  const maximumCount = new Uint32Array(size);
  for (let row = 0; row < selection.length; ++row) {
    const rank = colors.bins[row];
    if (selection[row] === 0 || rank >= colors.colorMapBins) continue;
    const cell = endpoint(left?.[row]) * (bins + 1) + endpoint(right?.[row]);
    if (rank === histogram.minimum[cell]) minimumCount[cell] += 1;
    if (rank === histogram.maximum[cell]) maximumCount[cell] += 1;
  }
  return { ...histogram, minimumCount, maximumCount };
}

function matchesScratch(update: ContinuousUpdate, input: ContinuousRequest): void {
  const selection = input.selection;
  if (selection === undefined) throw new Error("Incomplete reference selection");
  const selected = total(Uint32Array.from(selection));
  expect(update.rows).toBe(selection.length);
  expect(update.selectedCount).toBe(selected);
  expect(update.contextCount).toBe(selection.length - selected);
  for (const pair of update.pairs) {
    const reference = scratch(input, pair.left.column, pair.right.column);
    sameHistogram(pair.histogram, reference);
    for (const name of ["minimumCount", "maximumCount"] as const) {
      expect(Reflect.get(pair.histogram, name)).toEqual(reference[name]);
    }
    expect(total(pair.histogram.selected)).toBe(selected);
    expect(total(pair.histogram.context)).toBe(selection.length - selected);
  }
}

function randomGenerator(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomRequest(categorical: boolean): ContinuousRequest {
  const random = randomGenerator(20261110);
  const rows = 384;
  return request({
    height: 256,
    axes: [
      { column: 10, x: 10 },
      { column: 20, x: 45 },
      { column: 30, x: 90 },
    ],
    columns: [10, 20, 30].map((id) => ({
      id,
      pixels: Float32Array.from({ length: rows }, () =>
        random() < 0.13 ? Number.NaN : Math.floor(random() * 8) * 36,
      ),
    })),
    selection: Uint8Array.from({ length: rows }, () => (random() < 0.5 ? 0 : 1)),
    colors: {
      bins: Uint32Array.from({ length: rows }, () => Math.floor(random() * palette.length)),
      palette,
      colorMapBins: categorical ? 0 : 4,
    },
  });
}

function permute(input: ContinuousRequest, indices: Uint32Array): ContinuousRequest {
  const { colors, selection } = input;
  if (colors === undefined || selection === undefined) throw new Error("Incomplete permuted input");
  return {
    ...input,
    columns: input.columns.map(({ id, pixels }) => ({
      id,
      pixels: Float32Array.from(indices, (row) => pixels[row]),
    })),
    colors: { ...colors, bins: Uint32Array.from(indices, (row) => colors.bins[row]) },
    selection: Uint8Array.from(indices, (row) => selection[row]),
  };
}

describe("continuous all-row counting", () => {
  test("counts all endpoint combinations, both-missing mass and raw numeric ranks", () => {
    const input = request();
    const update = new ContinuousKernel().update(input);
    matchesScratch(update, input);
    expect(update.axisBins).toBe(MIN_DENSITY_BINS);
    expect(update.changedRows).toBe(5);
    expect(update.countMs).toBeGreaterThanOrEqual(0);
    const histogram = update.pairs[1].histogram;
    expect(histogram.selected).toBeInstanceOf(Uint32Array);
    expect(histogram.minimum).toBeInstanceOf(Uint32Array);
    expect(histogram.color0).toBeInstanceOf(Float64Array);
    expect(total(histogram.color0)).toBe(4);
    expect(total(histogram.color1)).toBe(1);
    expect(total(histogram.color2)).toBe(0);
    expect(histogram.occupied).toContain((MIN_DENSITY_BINS + 1) ** 2 - 1);
    expect(histogram.occupied.length).toBe(4);
  });

  test("rounds to endpoint coordinates rather than interval edges and clamps finite pixels", () => {
    const height = 300;
    const bins = 300;
    const pixels = new Float32Array([
      -20,
      0,
      0.49 * (height / (bins - 1)),
      0.51 * (height / (bins - 1)),
      150,
      height,
      height + 20,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    const input = request({
      height,
      axes: [{ column: 1, x: 50 }],
      columns: [{ id: 1, pixels }],
      selection: new Uint8Array(pixels.length).fill(1),
      colors: { bins: new Uint32Array(pixels.length), palette, colorMapBins: 0 },
    });
    const update = new ContinuousKernel().update(input);
    expect(update.axisBins).toBe(bins);
    matchesScratch(update, input);
    const leading = update.pairs[0].histogram;
    const endpointBins = [0, 0, 0, 1, 150, 299, 299, 300, 300, 300];
    for (const bin of new Set(endpointBins)) {
      expect(leading.selected[bins * (bins + 1) + bin]).toBe(
        endpointBins.filter((value) => value === bin).length,
      );
    }
  });

  test("uses rendered categorical and inverted coordinates without interpreting source values", () => {
    const input = request({
      height: 256,
      columns: [
        { id: 1, pixels: new Float32Array([0, 64, 128, 192, 256]) },
        { id: 2, pixels: new Float32Array([256, 192, 128, 64, 0]) },
      ],
    });
    matchesScratch(new ContinuousKernel().update(input), input);
    const inverted = {
      ...input,
      columns: input.columns.map(({ id, pixels }) => ({
        id,
        pixels: Float32Array.from(pixels, (pixel) => input.height - pixel),
      })),
    };
    const kernel = new ContinuousKernel();
    kernel.update(input);
    matchesScratch(kernel.update(inverted), inverted);
  });

  test("categorical colors, including the missing category, use reversible fixed-point RGB", () => {
    const input = request({
      colors: { bins: new Uint32Array([0, 1, 2, 3, 4]), palette, colorMapBins: 0 },
    });
    const kernel = new ContinuousKernel();
    matchesScratch(kernel.update(input), input);
    const selection = new Uint8Array([0, 1, 1, 1, 0]);
    const update = kernel.update(cachedRequest(input, { selection }));
    matchesScratch(update, { ...input, selection });
    for (const histogram of update.pairs.map((pair) => pair.histogram)) {
      for (const name of ["color0", "color1", "color2"] as const) {
        expect(histogram[name].every(Number.isSafeInteger)).toBe(true);
      }
      expect(histogram.minimum.every((value) => value === EMPTY_COLOR_KEY)).toBe(true);
      expect(histogram.maximum.every((value) => value === EMPTY_COLOR_KEY)).toBe(true);
    }
  });

  test("dense counts and color contributions never saturate at 2048 or 65535 rows", () => {
    const rows = 100_000;
    for (const categorical of [true, false]) {
      const input = request({
        columns: [
          { id: 1, pixels: new Float32Array(rows).fill(20) },
          { id: 2, pixels: new Float32Array(rows).fill(80) },
        ],
        colors: {
          bins: new Uint32Array(rows).fill(3),
          palette,
          colorMapBins: categorical ? 0 : 4,
        },
        selection: new Uint8Array(rows).fill(1),
      });
      const kernel = new ContinuousKernel();
      const before = kernel.update(input);
      expect(total(before.pairs[1].histogram.selected)).toBe(rows);
      expect(total(before.pairs[1].histogram.color0)).toBe(
        rows * (categorical ? COLOR_CHANNEL_SCALE : 3),
      );
      const selection = new Uint8Array(rows);
      selection[rows - 1] = 1;
      matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    }
  });

  test("numeric ranks above 65535 retain their raw sums and Uint32 extrema", () => {
    const colorMapBins = 65537;
    const colors: LineColors = {
      bins: new Uint32Array([65536, 65535, 0, colorMapBins, 1]),
      palette: Array.from({ length: colorMapBins + 1 }, () => palette[0]),
      colorMapBins,
    };
    const input = request({ colors, selection: new Uint8Array(5).fill(1) });
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const histogram = first.pairs[1].histogram;
    expect(total(histogram.color0)).toBe(65536 + 65535 + 1);
    expect(histogram.maximum[histogram.occupied[0]]).toBe(65536);
    const selection = new Uint8Array([0, 1, 1, 1, 1]);
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    expect(histogram.maximum[histogram.occupied[0]]).toBe(65535);
  });

  test("empty rows and an empty axis list are defined without invented population", () => {
    const empty = request({
      columns: [
        { id: 1, pixels: new Float32Array() },
        { id: 2, pixels: new Float32Array() },
      ],
      colors: { bins: new Uint32Array(), palette: [], colorMapBins: 0 },
      selection: new Uint8Array(),
    });
    const kernel = new ContinuousKernel();
    const update = kernel.update(empty);
    matchesScratch(update, empty);
    expect(update.changedRows).toBe(0);
    expect(update.pairs.every((pair) => pair.histogram.occupied.length === 0)).toBe(true);
    expect(kernel.update(cachedRequest(empty, { axes: [] })).pairs).toEqual([]);
  });
});

describe("exact reversible brush updates", () => {
  for (const categorical of [false, true]) {
    test(`${categorical ? "categorical" : "numeric"} randomized brushes exactly equal every scratch array`, () => {
      const input = randomRequest(categorical);
      const kernel = new ContinuousKernel();
      matchesScratch(kernel.update(input), input);
      const random = randomGenerator(445566);
      const selection = input.selection;
      if (selection === undefined) throw new Error("Incomplete random selection");
      for (let step = 0; step < 32; ++step) {
        const previous = selection.slice();
        for (let flip = 0; flip < 1 + step * 2; ++flip) {
          const row = Math.floor(random() * selection.length);
          selection[row] = 1 - selection[row];
        }
        const update = kernel.update(cachedRequest(input, { selection }));
        expect(update.changedRows).toBe(
          selection.reduce((count, value, row) => count + Number(value !== previous[row]), 0),
        );
        matchesScratch(update, input);
      }
    });

    test(`${categorical ? "categorical" : "numeric"} counts are independent of source-row permutation`, () => {
      const input = randomRequest(categorical);
      const baseline = new ContinuousKernel().update(input);
      const rows = baseline.rows;
      const reversed = Uint32Array.from({ length: rows }, (_, row) => rows - 1 - row);
      const random = randomGenerator(919191);
      const shuffled = reversed.slice();
      for (let index = rows - 1; index > 0; --index) {
        const other = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      for (const indices of [reversed, shuffled]) {
        const permuted = new ContinuousKernel().update(permute(input, indices));
        for (let pair = 0; pair < baseline.pairs.length; ++pair) {
          sameHistogram(permuted.pairs[pair].histogram, baseline.pairs[pair].histogram);
        }
      }
    });
  }

  for (const categorical of [false, true]) {
    test(`${categorical ? "categorical" : "numeric"} population changes skip redundant cell snapshots`, () => {
      const input = request({
        columns: [1, 2].map((id) => ({ id, pixels: new Float32Array(5).fill(64) })),
        colors: { bins: Uint32Array.of(0, 0, 1, 3, 4), palette, colorMapBins: categorical ? 0 : 4 },
        selection: Uint8Array.of(1, 1, 0, 0, 1),
      });
      const kernel = new ContinuousKernel();
      kernel.update(input);
      // An equal-population exchange still needs exact before/after statistics.
      kernel.update(cachedRequest(input, { selection: Uint8Array.of(0, 1, 1, 0, 1) }));
      const snapshots = Reflect.get(kernel, "maskScratch") as { selected: Uint32Array };
      let snapshotWrites = 0;
      snapshots.selected = new Proxy(snapshots.selected, {
        set(target, property, value) {
          snapshotWrites++;
          return Reflect.set(target, property, value, target);
        },
      });
      for (const mask of [
        [1, 1, 1, 1, 1],
        [0, 0, 1, 0, 1],
        [1, 0, 0, 1, 1],
        [0, 0, 0, 0, 0],
      ]) {
        const selection = new Uint8Array(mask);
        const update = kernel.update(cachedRequest(input, { selection }));
        matchesScratch(update, { ...input, selection });
      }
      expect(snapshotWrites).toBe(0);
    });
  }

  test("removing one of 10000 tied extrema avoids membership traversal", () => {
    const rows = 10_000;
    const input = request({
      height: 255,
      columns: [1, 2].map((id) => ({ id, pixels: new Float32Array(rows).fill(64) })),
      selection: new Uint8Array(rows).fill(1),
      colors: { bins: new Uint32Array(rows), palette, colorMapBins: 4 },
    });
    const kernel = new ContinuousKernel();
    kernel.update(input);
    const pairs = Reflect.get(kernel, "pairs") as Map<string, { next: Uint32Array }>;
    const pair = pairs.get("1:2");
    if (pair === undefined) throw new Error("Missing retained interior pair");
    let membershipReads = 0;
    pair.next = new Proxy(pair.next, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) ++membershipReads;
        return Reflect.get(target, property, target);
      },
    });
    const selection = new Uint8Array(rows).fill(1);
    selection[0] = 0;
    const update = kernel.update(cachedRequest(input, { selection }));
    expect(update.changedRows).toBe(1);
    matchesScratch(update, { ...input, selection });
    expect(membershipReads).toBe(0);
    selection[0] = 1;
    selection[1] = 0;
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    expect(membershipReads).toBe(0);
    selection.fill(0);
    selection[2] = 1;
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    expect(membershipReads).toBe(0);
    selection[2] = 0;
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    expect(membershipReads).toBe(0);
    selection.fill(1);
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    expect(membershipReads).toBe(0);
  });

  test("recoloring refreshes multiplicities even when visible statistics and revisions match", () => {
    const input = request({
      columns: [1, 2].map((id) => ({ id, pixels: new Float32Array(5).fill(64) })),
      selection: new Uint8Array(5).fill(1),
      colors: { bins: new Uint32Array([0, 0, 1, 2, 2]), palette, colorMapBins: 4 },
    });
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const colors = { bins: new Uint32Array([0, 1, 1, 1, 2]), palette, colorMapBins: 4 };
    const recolored = kernel.update(cachedRequest(input, { colors }));
    expect(recolored.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    matchesScratch(recolored, { ...input, colors });
    const selection = new Uint8Array([0, 1, 1, 1, 1]);
    matchesScratch(kernel.update(cachedRequest(input, { selection })), {
      ...input,
      colors,
      selection,
    });
  });

  test("removing the last tied extrema rescans cell members and missing colors never win", () => {
    const input = request({
      columns: [
        { id: 1, pixels: new Float32Array(6).fill(20) },
        { id: 2, pixels: new Float32Array(6).fill(70) },
      ],
      selection: new Uint8Array(6).fill(1),
      colors: { bins: new Uint32Array([0, 0, 1, 3, 3, 4]), palette, colorMapBins: 4 },
    });
    const kernel = new ContinuousKernel();
    kernel.update(input);
    for (const [mask, minimum, maximum] of [
      [[0, 1, 1, 1, 1, 1], 0, 3],
      [[0, 0, 1, 1, 1, 1], 1, 3],
      [[0, 0, 1, 0, 0, 1], 1, 1],
      [[0, 0, 0, 0, 0, 1], EMPTY_COLOR_KEY, EMPTY_COLOR_KEY],
      [[0, 0, 0, 0, 0, 0], EMPTY_COLOR_KEY, EMPTY_COLOR_KEY],
      [[1, 0, 0, 0, 1, 1], 0, 3],
    ] as const) {
      const selection = new Uint8Array(mask);
      const update = kernel.update(cachedRequest(input, { selection }));
      matchesScratch(update, { ...input, selection });
      const histogram = update.pairs[1].histogram;
      expect(histogram.minimum[histogram.occupied[0]]).toBe(minimum);
      expect(histogram.maximum[histogram.occupied[0]]).toBe(maximum);
    }
  });

  test("only changed masks touch grids and cancelling exchanges retain revisions", () => {
    const input = request({
      columns: [
        { id: 1, pixels: new Float32Array([20, 20]) },
        { id: 2, pixels: new Float32Array([70, 70]) },
      ],
      selection: new Uint8Array([1, 0]),
      colors: { bins: new Uint32Array([2, 2]), palette, colorMapBins: 4 },
    });
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const noChange = kernel.update(cachedRequest(input, { selection: input.selection }));
    expect(noChange.changedRows).toBe(0);
    expect(noChange.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    const exchanged = kernel.update(cachedRequest(input, { selection: new Uint8Array([0, 1]) }));
    expect(exchanged.changedRows).toBe(2);
    expect(exchanged.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    const removed = kernel.update(cachedRequest(input, { selection: new Uint8Array([0, 0]) }));
    expect(removed.changedRows).toBe(1);
    expect(
      removed.pairs.every(({ histogram }, index) => histogram.revision > revisions[index]),
    ).toBe(true);
    matchesScratch(removed, { ...input, selection: new Uint8Array([0, 0]) });
  });

  for (const categorical of [false, true]) {
    test(`${categorical ? "categorical" : "numeric"} touched-cell scratch is reused across pairs and cancelling updates`, () => {
      const input = request({
        axes: [
          { column: 1, x: 10 },
          { column: 2, x: 50 },
          { column: 3, x: 90 },
        ],
        columns: [
          { id: 1, pixels: new Float32Array([Number.NaN, Number.NaN, 20, 20, 40, Number.NaN]) },
          { id: 2, pixels: new Float32Array([Number.NaN, 70, Number.NaN, 70, 70, Number.NaN]) },
          { id: 3, pixels: new Float32Array([Number.NaN, 70, 40, Number.NaN, 70, Number.NaN]) },
        ],
        colors: {
          bins: new Uint32Array([0, 3, 1, 4, 2, 0]),
          palette,
          colorMapBins: categorical ? 0 : 4,
        },
        selection: new Uint8Array([1, 1, 0, 1, 1, 0]),
      });
      const kernel = new ContinuousKernel();
      const first = kernel.update(input);
      const revisions = first.pairs.map(({ histogram }) => histogram.revision);
      const selection = new Uint8Array([0, 1, 0, 1, 1, 1]);
      const exchanged = kernel.update(cachedRequest(input, { selection }));
      expect(exchanged.changedRows).toBe(2);
      expect(exchanged.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
      matchesScratch(exchanged, { ...input, selection });
      const workspace = Reflect.get(kernel, "maskScratch") as { state: Uint8Array };
      expect(workspace.state).toBeInstanceOf(Uint8Array);
      expect(workspace.state.every((value) => value === 0)).toBe(true);
      for (const mask of [
        [0, 0, 1, 1, 0, 1],
        [1, 1, 1, 1, 1, 1],
        [0, 0, 0, 0, 0, 0],
        [1, 1, 0, 1, 1, 0],
      ]) {
        const selection = new Uint8Array(mask);
        const update = kernel.update(cachedRequest(input, { selection }));
        matchesScratch(update, { ...input, selection });
        expect(Reflect.get(kernel, "maskScratch")).toBe(workspace);
        expect(workspace.state.every((value) => value === 0)).toBe(true);
      }
    });
  }

  test("touched-cell scratch grows after resize and is retained when the grid shrinks", () => {
    const input = randomRequest(false);
    const kernel = new ContinuousKernel();
    kernel.update(input);
    const selection = input.selection?.slice();
    if (selection === undefined) throw new Error("Incomplete resize selection");
    selection[0] = 1 - selection[0];
    matchesScratch(kernel.update(cachedRequest(input, { selection })), { ...input, selection });
    let workspace = Reflect.get(kernel, "maskScratch") as { state: Uint8Array };
    expect(workspace.state.length).toBe((MIN_DENSITY_BINS + 1) ** 2);
    for (const height of [300.1, 100, 300.1]) {
      const resized = kernel.update(cachedRequest(input, { height }));
      expect(Reflect.get(kernel, "maskScratch")).toBe(workspace);
      matchesScratch(resized, { ...input, height, selection });
      selection[0] = 1 - selection[0];
      const update = kernel.update(cachedRequest(input, { height, selection }));
      matchesScratch(update, { ...input, height, selection });
      const nextWorkspace = Reflect.get(kernel, "maskScratch") as { state: Uint8Array };
      if (workspace.state.length < (update.axisBins + 1) ** 2) {
        expect(nextWorkspace).not.toBe(workspace);
      } else {
        expect(nextWorkspace).toBe(workspace);
      }
      expect(nextWorkspace.state.length).toBe(302 ** 2);
      expect(nextWorkspace.state.every((value) => value === 0)).toBe(true);
      workspace = nextWorkspace;
    }
  });

  test("a one-row mask delta writes only its retained cell rather than recounting other rows", () => {
    const input = request();
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const histogram = first.pairs[1].histogram;
    const original = { ...histogram };
    const written = new Set<number>();
    const tracked = <T extends Uint32Array | Float64Array>(array: T): T =>
      new Proxy(array, {
        set(target, property, value) {
          written.add(Number(property));
          return Reflect.set(target, property, value);
        },
      });
    Object.assign(histogram, {
      selected: tracked(histogram.selected),
      context: tracked(histogram.context),
      color0: tracked(histogram.color0),
      color1: tracked(histogram.color1),
      color2: tracked(histogram.color2),
      minimum: tracked(histogram.minimum),
      maximum: tracked(histogram.maximum),
    });
    const selection = new Uint8Array([1, 1, 1, 1, 1]);
    const update = kernel.update(cachedRequest(input, { selection }));
    expect(update.changedRows).toBe(1);
    expect([...written]).toEqual([51 * (histogram.bins + 1) + histogram.bins]);
    Object.assign(histogram, {
      selected: original.selected,
      context: original.context,
      color0: original.color0,
      color1: original.color1,
      color2: original.color2,
      minimum: original.minimum,
      maximum: original.maximum,
    });
    matchesScratch(update, { ...input, selection });
  });

  test("membership changes with identical statistics still affect later extrema correctly", () => {
    const input = request({
      columns: [
        { id: 1, pixels: new Float32Array([20, 20, 20]) },
        { id: 2, pixels: new Float32Array([70, 70, 70]) },
      ],
      selection: new Uint8Array([1, 0, 1]),
      colors: { bins: new Uint32Array([0, 0, 3]), palette, colorMapBins: 4 },
    });
    const kernel = new ContinuousKernel();
    kernel.update(input);
    kernel.update(cachedRequest(input, { selection: new Uint8Array([0, 1, 1]) }));
    const selection = new Uint8Array([0, 0, 1]);
    const update = kernel.update(cachedRequest(input, { selection }));
    matchesScratch(update, { ...input, selection });
    const histogram = update.pairs[1].histogram;
    expect(histogram.minimum[histogram.occupied[0]]).toBe(3);
  });
});

describe("retained geometry and color caches", () => {
  test("outer pairs retain missing-axis bins and exactly 15-pixel stubs", () => {
    const input = request();
    const update = new ContinuousKernel().update(input);
    expect(update.pairs.map(({ key }) => key)).toEqual(["-1:1", "1:2", "2:-1"]);
    expect(update.pairs[0].left).toEqual({ column: -1, x: 5 });
    expect(update.pairs[2].right).toEqual({ column: -1, x: 95 });
    const bins = update.axisBins;
    expect(
      update.pairs[0].histogram.occupied.every((cell) => Math.floor(cell / (bins + 1)) === bins),
    ).toBe(true);
    expect(update.pairs[2].histogram.occupied.every((cell) => cell % (bins + 1) === bins)).toBe(
      true,
    );
    const single = new ContinuousKernel().update({ ...input, axes: [{ column: 1, x: 40 }] });
    expect(single.pairs.map(({ key }) => key)).toEqual(["-1:1", "1:-1"]);
    expect(single.pairs[0].left.x).toBe(25);
    expect(single.pairs[1].right.x).toBe(55);
  });

  test("scroll and style changes retain histograms and revisions but refresh axis positions", () => {
    const input = request();
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const scrolled = kernel.update(
      cachedRequest(input, {
        width: 50,
        pixelRatio: 2,
        lineWidth: 2,
        colorMode: "highest",
        curved: true,
        draft: true,
        axes: input.axes.map((axis) => ({ ...axis, x: axis.x - 50 })),
      }),
    );
    expect(scrolled.changedRows).toBe(0);
    expect(scrolled.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    for (let index = 0; index < first.pairs.length; ++index) {
      expect(scrolled.pairs[index].histogram).toBe(first.pairs[index].histogram);
    }
    expect(scrolled.pairs[0].left.x).toBe(-45);
    expect(first.pairs[0].left.x).toBe(5);
  });

  test("column replacement invalidates only adjoining pairs and order keys remain directed", () => {
    const input = randomRequest(false);
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const replacement = {
      id: 10,
      pixels: Float32Array.from(input.columns[0].pixels, (pixel) => input.height - pixel),
    };
    const changed = kernel.update(cachedRequest(input, { columns: [replacement] }));
    expect(changed.pairs[0].histogram.revision).toBeGreaterThan(revisions[0]);
    expect(changed.pairs[1].histogram.revision).toBeGreaterThan(revisions[1]);
    expect(changed.pairs[2].histogram).toBe(first.pairs[2].histogram);
    expect(changed.pairs[3].histogram).toBe(first.pairs[3].histogram);
    const current = { ...input, columns: [replacement, ...input.columns.slice(1)] };
    matchesScratch(changed, current);
    const axes = [...input.axes].reverse();
    const reversed = kernel.update(cachedRequest(input, { axes }));
    expect(reversed.pairs.map(({ key }) => key)).toEqual(["-1:30", "30:20", "20:10", "10:-1"]);
    matchesScratch(reversed, { ...current, axes });
  });

  test("obsolete source column identities are evicted when geometry is replaced", () => {
    const input = request();
    const kernel = new ContinuousKernel();
    kernel.update(input);
    const axes = [{ column: 3, x: 20 }, input.axes[1]];
    const columns = [{ id: 3, pixels: new Float32Array([5, 10, 20, 30, 40]) }];
    kernel.update(cachedRequest(input, { axes, columns }));
    expect(() => kernel.update(cachedRequest(input))).toThrow("Unknown continuous axis column 1");
    const restored = kernel.update(cachedRequest(input, { columns: input.columns }));
    matchesScratch(restored, input);
  });

  test("reordering keeps any unchanged adjacency and hidden columns can be reuploaded", () => {
    const input = randomRequest(true);
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const axes = [input.axes[1], input.axes[2], input.axes[0]];
    const reordered = kernel.update(cachedRequest(input, { axes }));
    expect(reordered.pairs[1].key).toBe("20:30");
    expect(reordered.pairs[1].histogram).toBe(first.pairs[2].histogram);
    const restored = kernel.update(cachedRequest(input));
    matchesScratch(restored, input);
    const hidden = kernel.update(cachedRequest(input, { axes: [] }));
    expect(hidden.pairs.length).toBe(0);
    matchesScratch(kernel.update(cachedRequest(input, { columns: input.columns })), input);
  });

  test("duplicate directed pairs share one update instead of applying mask deltas twice", () => {
    const initial = request();
    const input = {
      ...initial,
      axes: [initial.axes[0], initial.axes[1], initial.axes[0], initial.axes[1]],
    };
    const kernel = new ContinuousKernel();
    kernel.update(input);
    const selection = new Uint8Array([0, 1, 1, 0, 0]);
    const update = kernel.update(cachedRequest(input, { selection }));
    expect(update.pairs[1].histogram).toBe(update.pairs[3].histogram);
    matchesScratch(update, { ...input, selection });
  });

  test("resize requantizes original pixels even inside an unchanged bin-count clamp", () => {
    const input = request();
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const resized = kernel.update(cachedRequest(input, { height: 200 }));
    expect(resized.axisBins).toBe(first.axisBins);
    expect(resized.pairs[1].histogram).not.toBe(first.pairs[1].histogram);
    expect(resized.pairs[1].histogram.revision).toBeGreaterThan(first.pairs[1].histogram.revision);
    matchesScratch(resized, { ...input, height: 200 });
    const fractional = kernel.update(cachedRequest(input, { height: 300.1 }));
    expect(fractional.axisBins).toBe(301);
    matchesScratch(fractional, { ...input, height: 300.1 });
  });

  test("pixel-height bin storage clamps at both explicit limits", () => {
    for (const [height, bins] of [
      [0.1, MIN_DENSITY_BINS],
      [255.5, MIN_DENSITY_BINS],
      [465, 465],
      [1024.1, MAX_DENSITY_BINS],
      [2048, MAX_DENSITY_BINS],
    ]) {
      const update = new ContinuousKernel().update(
        request({ height, axes: [{ column: 1, x: 50 }] }),
      );
      expect(update.axisBins).toBe(bins);
      expect(update.pairs[0].histogram.selected.length).toBe((bins + 1) ** 2);
    }
  });

  test("recoloring retains geometry and recomputes numeric, categorical and missing statistics", () => {
    const input = request();
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const histogram = first.pairs[1].histogram;
    const occupied = histogram.occupied;
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const same = kernel.update(cachedRequest(input, { colors: input.colors }));
    expect(same.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    const categorical: LineColors = {
      bins: new Uint32Array([4, 3, 2, 1, 0]),
      palette,
      colorMapBins: 0,
    };
    const changed = kernel.update(cachedRequest(input, { colors: categorical }));
    expect(changed.changedRows).toBe(0);
    expect(changed.pairs[1].histogram).toBe(histogram);
    expect(changed.pairs[1].histogram.occupied).toBe(occupied);
    matchesScratch(changed, { ...input, colors: categorical });
    const selection = new Uint8Array([0, 1, 1, 0, 0]);
    const numeric: LineColors = {
      bins: new Uint32Array([4, 4, 2, 1, 0]),
      palette,
      colorMapBins: 4,
    };
    const together = kernel.update(cachedRequest(input, { colors: numeric, selection }));
    expect(together.changedRows).toBe(4);
    matchesScratch(together, { ...input, colors: numeric, selection });
  });

  test("color updates only revise grids whose selected statistics change", () => {
    const input = request({ selection: new Uint8Array([0, 0, 0, 0, 0]) });
    const kernel = new ContinuousKernel();
    const first = kernel.update(input);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    const recolored = kernel.update(
      cachedRequest(input, {
        colors: { bins: new Uint32Array([4, 0, 0, 0, 0]), palette, colorMapBins: 0 },
      }),
    );
    expect(recolored.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
  });

  test("input snapshots survive caller mutation and support later resize and delta updates", () => {
    const input = request();
    const original = request();
    const kernel = new ContinuousKernel();
    kernel.update(input);
    input.columns[0].pixels.fill(90);
    input.colors?.bins.fill(4);
    input.selection?.fill(0);
    const retained = kernel.update(cachedRequest(input));
    matchesScratch(retained, original);
    const resized = kernel.update(cachedRequest(input, { height: 200 }));
    matchesScratch(resized, { ...original, height: 200 });
    const changed = kernel.update(
      cachedRequest(input, { selection: input.selection, height: 200 }),
    );
    expect(changed.changedRows).toBe(4);
    matchesScratch(changed, { ...original, selection: input.selection, height: 200 });
  });

  test("a new row population replaces retained columns and cannot reuse old row identities", () => {
    const kernel = new ContinuousKernel();
    kernel.update(request());
    const input = randomRequest(true);
    matchesScratch(kernel.update(input), input);
    expect(() => kernel.update(cachedRequest(input, { axes: [{ column: 1, x: 10 }] }))).toThrow(
      "Unknown continuous axis column",
    );
  });
});

describe("malformed continuous input", () => {
  test("initial colors and mask are required even with no visible axes", () => {
    for (const overrides of [{ colors: undefined }, { selection: undefined }]) {
      expect(() => new ContinuousKernel().update(request({ axes: [], ...overrides }))).toThrow(
        "needs colors and selection",
      );
    }
  });

  test("source columns, palette ranks and masks must identify the same rows", () => {
    for (const overrides of [
      { selection: new Uint8Array(4) },
      { columns: [{ id: 1, pixels: new Float32Array(4) }] },
      { colors: { bins: new Uint32Array(6), palette, colorMapBins: 0 } },
    ]) {
      expect(() => new ContinuousKernel().update(request(overrides))).toThrow("same rows");
    }
  });

  test("non-binary masks fail before retained state is modified", () => {
    const initial = request();
    const kernel = new ContinuousKernel();
    const first = kernel.update(initial);
    const revisions = first.pairs.map(({ histogram }) => histogram.revision);
    expect(() =>
      kernel.update(cachedRequest(initial, { selection: new Uint8Array([0, 0, 0, 2, 1]) })),
    ).toThrow("only 0 or 1");
    const unchanged = kernel.update(cachedRequest(initial));
    expect(unchanged.pairs.map(({ histogram }) => histogram.revision)).toEqual(revisions);
    matchesScratch(unchanged, initial);
  });

  test("unknown palette ranks and invalid numeric missing ranks fail even on context rows", () => {
    for (const colors of [
      { bins: new Uint32Array([0, 0, 0, 0, 5]), palette, colorMapBins: 0 },
      { bins: new Uint32Array([0, 0, 0, 0, 4]), palette, colorMapBins: 2 },
      { bins: new Uint32Array([0, 0, 0, 0, EMPTY_COLOR_KEY]), palette, colorMapBins: 4 },
    ]) {
      expect(() =>
        new ContinuousKernel().update(request({ colors, selection: new Uint8Array(5) })),
      ).toThrow("Unknown continuous palette rank");
    }
  });

  test("numeric exactness bounds fail before inspecting an impractically large palette", () => {
    const rows = 2 ** 21 + 1;
    const oversizedPalette = new Array<(typeof palette)[number]>(EMPTY_COLOR_KEY);
    expect(() =>
      new ContinuousKernel().update(
        request({
          selection: new Uint8Array(rows),
          colors: {
            bins: new Uint32Array(rows),
            palette: oversizedPalette,
            colorMapBins: EMPTY_COLOR_KEY - 1,
          },
        }),
      ),
    ).toThrow("exceed the exact integer range");
  });

  test("invalid color map sizes and channel values are rejected", () => {
    for (const colorMapBins of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, palette.length]) {
      expect(() =>
        new ContinuousKernel().update(
          request({ colors: { bins: new Uint32Array(5), palette, colorMapBins } }),
        ),
      ).toThrow("valid color map");
    }
    for (const r of [-1, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        new ContinuousKernel().update(
          request({
            colors: {
              bins: new Uint32Array(5),
              palette: [{ r, g: 0, b: 0 }],
              colorMapBins: 0,
            },
          }),
        ),
      ).toThrow("palette channels");
    }
  });

  test("invalid heights, IDs and axis positions fail loudly", () => {
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ContinuousKernel().update(request({ height }))).toThrow("axis height");
    }
    for (const id of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        new ContinuousKernel().update(request({ columns: [{ id, pixels: new Float32Array(5) }] })),
      ).toThrow("column IDs");
    }
    const input = request();
    expect(() =>
      new ContinuousKernel().update({ ...input, columns: [...input.columns, input.columns[0]] }),
    ).toThrow("column IDs");
    expect(() => new ContinuousKernel().update(request({ axes: [{ column: 99, x: 0 }] }))).toThrow(
      "Unknown continuous axis column",
    );
    expect(() =>
      new ContinuousKernel().update(request({ axes: [{ column: 1, x: Number.NaN }] })),
    ).toThrow("axis positions");
  });
});
