import { reduceContinuousMarginalCPU } from "../src/parallel/continuous_density";
import type { ContinuousHistogram } from "../src/parallel/continuous_types";
import { packHistogramCPU } from "../src/parallel/histogram_upload";
import { buildSelectionIndexCPU } from "../src/parallel/selection_index";
import { RustKernels } from "../src/wasm/kernels";
import { profileHistogramUploads } from "./rust_gpu";

function measure(run: () => unknown, repetitions: number): number {
  const samples: number[] = [];
  run();
  for (let rep = 0; rep < repetitions; ++rep) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** Includes every JS/WASM input copy and output copy, using the shipped bridge. */
export function profileRustKernels(rows: number, repetitions = 9) {
  const compiledAt = performance.now();
  const kernels = RustKernels.create();
  const compileMs = performance.now() - compiledAt;
  if (kernels === null) throw new Error("Rust/WASM unavailable in benchmark");
  let seed = 20261111;
  const values = Float64Array.from({ length: rows }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
  const missing = Uint8Array.from(values, (_, row) => Number(row % 97 === 0));
  const marginal = {
    pixels: Float32Array.from(values, (value) => value * 500),
    selection: Uint8Array.from(values, (_, row) => Number(row % 3 !== 0)),
    revision: 1,
  };
  const colors = {
    bins: Uint32Array.from(values, (value) => Math.floor(value * 256)),
    colorMapBins: 256,
    palette: Array.from({ length: 257 }, (_, rank) => ({
      r: Math.min(rank, 255),
      g: 255 - Math.min(rank, 255),
      b: 0,
    })),
  };
  const cases: { name: string; js: () => unknown; rust: () => unknown }[] = [
    {
      name: "numeric index",
      js: () => buildSelectionIndexCPU({ kind: "numeric", values, missing }),
      rust: () => kernels.numericIndex(values, missing),
    },
    {
      name: "outer marginal",
      js: () => reduceContinuousMarginalCPU(marginal, colors, 500, 1, "mean"),
      rust: () => kernels.marginal(marginal, colors, 500, 1, "mean"),
    },
  ];
  for (const cardinality of [16, Math.min(rows, 50_000)]) {
    const categories = Array.from(
      { length: cardinality },
      (_, code) => `category_${String(cardinality - code).padStart(6, "0")}`,
    );
    const codes = Int32Array.from({ length: rows }, (_, row) =>
      row % 97 === 0 ? -1 : (row * 7919) % cardinality,
    );
    cases.push({
      name: `categorical index (${cardinality} names)`,
      js: () => buildSelectionIndexCPU({ kind: "categorical", codes, categories }),
      rust: () => kernels.categoricalIndex(codes, categories),
    });
  }
  cases.push({
    name: "outer marginal (new mask)",
    js: () =>
      reduceContinuousMarginalCPU(
        { ...marginal, selection: marginal.selection.slice() },
        colors,
        500,
        1,
        "mean",
      ),
    rust: () =>
      kernels.marginal(
        { ...marginal, selection: marginal.selection.slice() },
        colors,
        500,
        1,
        "mean",
      ),
  });
  const cells = 501 ** 2;
  const histogram: ContinuousHistogram = {
    bins: 500,
    selected: new Uint32Array(cells).fill(2),
    context: new Uint32Array(cells).fill(1),
    color0: Float64Array.from({ length: cells }, (_, cell) => cell % 256),
    color1: new Float64Array(cells),
    color2: new Float64Array(cells).fill(65535),
    minimum: new Uint32Array(cells).fill(0),
    maximum: new Uint32Array(cells).fill(255),
    occupied: Uint32Array.from({ length: Math.min(rows, cells) }, (_, cell) => cell),
    revision: 1,
  };
  const packingSlots = [kernels.createHistogram(), kernels.createHistogram()];
  for (const extra of [false, true]) {
    const slot = packingSlots[Number(extra)];
    cases.push({
      name: `histogram packing (${extra ? "extra" : "mean"})`,
      js: () => packHistogramCPU(histogram, extra),
      rust: () => kernels.packHistogram(histogram, extra, slot, false),
    });
  }
  const result = {
    rows,
    repetitions,
    compileMs,
    cases: cases.map(({ name, js, rust }) => {
      const javascriptMs = measure(js, repetitions);
      rust();
      const copiedBefore = kernels.copiedInputBytes;
      const rustMs = measure(rust, repetitions);
      return {
        name,
        javascriptMs,
        rustMs,
        copiedInputBytesPerCall: (kernels.copiedInputBytes - copiedBefore) / (repetitions + 1),
        wasmMemoryBytes: kernels.memoryBytes,
      };
    }),
  };
  for (const slot of packingSlots) kernels.releaseHistogram(slot);
  return result;
}

Object.assign(globalThis, { rustBenchmark: { profileRustKernels, profileHistogramUploads } });
