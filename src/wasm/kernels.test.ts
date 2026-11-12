import { expect, test } from "bun:test";
import { reduceContinuousMarginalCPU } from "../parallel/continuous_density";
import type { ContinuousMarginal } from "../parallel/continuous_types";
import { buildSelectionIndexCPU } from "../parallel/selection_index";
import type { LineColors } from "../parallel/webgl";
import { RustKernels } from "./kernels";

function create(): RustKernels {
  const kernels = RustKernels.create();
  if (kernels === null) throw new Error("Tests require the compiled Rust kernels");
  return kernels;
}

test("numeric WASM indices exactly match the reference across missing values and stable ties", () => {
  const kernels = create();
  let seed = 718;
  for (const length of [0, 1, 100, 50_000]) {
    const values = Float64Array.from({ length }, (_, row) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return [NaN, Infinity, -Infinity, -0, 0, 1 + Number.EPSILON, seed % 100][row % 7];
    });
    const missing = Uint8Array.from(values, (_, row) => Number(row % 13 === 0));
    const actual = kernels.numericIndex(values, missing);
    const expected = buildSelectionIndexCPU({ kind: "numeric", values, missing });
    if (expected.kind !== "numeric") throw new Error("Expected numeric reference");
    expect(Array.from(actual.order)).toEqual(Array.from(expected.order));
    expect(Array.from(actual.missing)).toEqual(Array.from(expected.missing));
    expect(actual.comparable).toBe(expected.comparable);
    // Bun 1.3.1 compares typed-array NaNs as unequal; scalar toBe uses Object.is.
    for (let position = 0; position < actual.values.length; ++position)
      expect(actual.values[position]).toBe(expected.values[position]);
  }
});

test("WASM results retain their own transferable storage after workspace growth and reuse", () => {
  const kernels = create();
  const result = kernels.numericIndex(Float64Array.of(3, 1, NaN), Uint8Array.of(0, 0, 1));
  const snapshot = structuredClone(result);
  kernels.numericIndex(new Float64Array(1_000_000), new Uint8Array(1_000_000));
  expect(result).toEqual(snapshot);
  const transferred = structuredClone(result, {
    transfer: [result.order.buffer, result.values.buffer, result.missing.buffer],
  });
  expect(transferred).toEqual(snapshot);
  expect(result.order.byteLength).toBe(0);
  expect(kernels.numericIndex(Float64Array.of(2, 1), new Uint8Array(2)).order).toEqual(
    Uint32Array.of(1, 0),
  );
});

test("categorical Rust buckets preserve UTF-16 order, duplicate definitions and original row ties", () => {
  const kernels = create();
  const categories = [
    "z",
    "10",
    "2",
    "",
    "é",
    "e\u0301",
    "\ud800",
    "\udfff",
    "😀",
    "\ue000",
    "same",
    "same",
    "unused",
  ];
  for (const rows of [0, 1, 100, 50_000]) {
    const codes = Int32Array.from({ length: rows }, (_, row) =>
      row % 17 === 0 ? -1 : (row * 7) % (categories.length - 1),
    );
    const actual = kernels.categoricalIndex(codes, categories);
    const expected = buildSelectionIndexCPU({ kind: "categorical", codes, categories });
    if (expected.kind !== "categorical") throw new Error("Expected categorical reference");
    expect(Array.from(actual.order)).toEqual(Array.from(expected.order));
    expect(Array.from(actual.missing)).toEqual(Array.from(expected.missing));
    expect(actual.values).toEqual(expected.values);
    expect(Array.from(actual.offsets)).toEqual(Array.from(expected.offsets));
  }
  expect(kernels.categoricalIndex(Int32Array.of(-1, -1), [])).toEqual({
    kind: "categorical",
    order: new Uint32Array(),
    missing: Uint32Array.of(0, 1),
    values: [],
    offsets: Uint32Array.of(0),
  });
});

test("retained marginal inputs copy only new snapshots and evict the least recent endpoint", () => {
  const kernels = create();
  const colors = {
    bins: Uint32Array.of(0, 1, 0),
    colorMapBins: 0,
    palette: [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
    ],
  };
  const selection = Uint8Array.of(1, 0, 1);
  const columns = [Float32Array.of(1, 2, 3), Float32Array.of(3, 2, 1), Float32Array.of(2, 3, 1)];
  const render = (pixels: Float32Array, selected = selection, currentColors = colors) => {
    const marginal = { pixels, selection: selected, revision: 1 };
    expect(kernels.marginal(marginal, currentColors, 8, 0.7, "mean")).toEqual(
      reduceContinuousMarginalCPU(marginal, currentColors, 8, 0.7, "mean"),
    );
  };
  render(columns[0]);
  const firstCopy = kernels.copiedInputBytes;
  render(columns[0]);
  expect(kernels.copiedInputBytes).toBe(firstCopy);
  render(columns[1]);
  expect(kernels.copiedInputBytes - firstCopy).toBe(columns[1].byteLength);
  render(columns[0]);
  render(columns[2]);
  const thirdCopy = kernels.copiedInputBytes;
  render(columns[0]);
  expect(kernels.copiedInputBytes).toBe(thirdCopy);
  render(columns[1]);
  expect(kernels.copiedInputBytes - thirdCopy).toBe(columns[1].byteLength);
  const nextSelection = Uint8Array.of(0, 1, 1);
  const beforeSelection = kernels.copiedInputBytes;
  render(columns[1], nextSelection);
  expect(kernels.copiedInputBytes - beforeSelection).toBe(nextSelection.byteLength);
  kernels.numericIndex(Float64Array.of(2, 1), Uint8Array.of(0, 0));
  render(columns[1], nextSelection);
  const changedColors = { ...colors, bins: Uint32Array.of(1, 0, 1) };
  render(columns[1], nextSelection, changedColors);
  expect(kernels.memoryBytes).toBeGreaterThan(0);
});

for (const mode of ["mean", "lowest", "highest"] as const) {
  for (const numeric of [false, true]) {
    test(`WASM ${numeric ? "numeric" : "categorical"} ${mode} marginals exactly preserve Float64 sums`, () => {
      const kernels = create();
      const rows = 30_000;
      const marginal: ContinuousMarginal = {
        pixels: Float32Array.from(
          { length: rows },
          (_, row) =>
            [NaN, Infinity, -Infinity, -100, 1000, (row % 127) + (row % 100) / 100][row % 6],
        ),
        selection: Uint8Array.from({ length: rows }, (_, row) => Number(row % 4 !== 0)),
        revision: 1,
      };
      const colors: LineColors = {
        bins: Uint32Array.from({ length: rows }, (_, row) => row % 4),
        palette: [
          { r: 1.1, g: 200.5, b: 30 },
          { r: 255, g: 0, b: 3 },
          { r: 0, g: 255, b: 0 },
          { r: 255, g: 0, b: 255 },
        ],
        colorMapBins: numeric ? 3 : 0,
      };
      for (const [width, ratio] of [
        [0.5, 1],
        [1, 1.25],
        [2.5, 2],
        [8, 3],
      ]) {
        const expected = reduceContinuousMarginalCPU(marginal, colors, 128, width, mode, ratio);
        const actual = kernels.marginal(marginal, colors, 128, width, mode, ratio);
        expect(actual).toEqual(expected);
      }
    });
  }
}

test("million-row coincident numeric ranks preserve exact reference sums for sharp palettes", () => {
  const kernels = create();
  const rows = 1_000_000;
  const marginal = {
    pixels: new Float32Array(rows).fill(10.125),
    selection: new Uint8Array(rows).fill(1),
    revision: 1,
  };
  const colors = {
    bins: new Uint32Array(rows).fill(227),
    colorMapBins: 256,
    palette: Array.from({ length: 257 }, (_, rank) => ({
      r: rank === 227 ? 255 : 0,
      g: 0,
      b: rank === 228 ? 255 : 0,
    })),
  };
  const expected = reduceContinuousMarginalCPU(marginal, colors, 16, 1, "highest");
  const actual = kernels.marginal(marginal, colors, 16, 1, "highest");
  expect(actual[10].color0).toBe(expected[10].color0);
  expect(actual[9].color0).toBe(expected[9].color0);
});

test("CSP compilation failures select the JavaScript fallback without hiding other errors", () => {
  const compileError = new WebAssembly.CompileError("Blocked by CSP");
  const original = Object.getOwnPropertyDescriptor(WebAssembly, "Module");
  if (original === undefined) throw new Error("Missing WebAssembly.Module descriptor");
  const module = (error: Error): void => {
    Object.defineProperty(WebAssembly, "Module", {
      value: class {
        constructor() {
          throw error;
        }
      },
      configurable: true,
    });
  };
  module(compileError);
  try {
    expect(RustKernels.create()).toBeNull();
    module(new Error("Unexpected kernel defect"));
    expect(() => RustKernels.create()).toThrow("Unexpected kernel defect");
  } finally {
    Object.defineProperty(WebAssembly, "Module", original);
  }
});

test("browsers without WebAssembly retain the JavaScript capability fallback", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
  if (original === undefined) throw new Error("Missing WebAssembly descriptor");
  try {
    Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true });
    expect(RustKernels.create()).toBeNull();
  } finally {
    Object.defineProperty(globalThis, "WebAssembly", original);
  }
});

test("mismatched kernel inputs fail before copying into WASM memory", () => {
  const kernels = create();
  expect(() => kernels.numericIndex(new Float64Array(2), new Uint8Array(1))).toThrow("must align");
  expect(() =>
    kernels.marginal(
      { pixels: new Float32Array(2), selection: new Uint8Array(1), revision: 1 },
      { bins: new Uint32Array(2), colorMapBins: 1, palette: [] },
      8,
      1,
      "mean",
    ),
  ).toThrow("must align");
});
