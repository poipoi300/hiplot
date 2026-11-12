import type { ContinuousPixel } from "../parallel/continuous_density";
import type { ContinuousHistogram, ContinuousMarginal } from "../parallel/continuous_types";
import type { LineColors } from "../parallel/webgl";
import embedded from "./embedded.generated";

/** Buffer identifiers in rust/src/lib.rs; offsets are queried after every allocation. */
enum KernelBuffer {
  Endpoints = 0,
  Selection = 1,
  Ranks = 2,
  Palette = 3,
  Statistics = 4,
  Values = 5,
  Order = 6,
  Missing = 7,
  Sorted = 8,
  PaletteSource = 9,
  Codes = 10,
  CategoryText = 11,
  CategoryStarts = 12,
  CategoryValues = 13,
  CategoryOffsets = 14,
  HistogramCounts = 15,
  HistogramColors = 16,
  HistogramCells = 17,
  PackedCounts = 18,
  PackedExtra = 19,
  DirtyRows = 20,
}

interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  prepare: (rows: number, height: number, palette: number, slot: number) => void;
  prepare_numeric: (rows: number) => void;
  prepare_categorical: (rows: number, categories: number, units: number) => void;
  buffer: (kind: number) => number;
  sort_numeric: () => number;
  present_count: () => number;
  group_categorical: () => number;
  quantize_palette: () => void;
  create_histogram: () => number;
  release_histogram: (slot: number) => void;
  prepare_histogram: (
    slot: number,
    stride: number,
    occupied: number,
    extra: number,
    reset: number,
    compact: number,
  ) => number;
  pack_histogram: () => number;
  reduce_marginal: (
    height: number,
    width: number,
    bins: number,
    mode: number,
    pixelRatio: number,
  ) => void;
}

/** Each worker retains two immutable endpoint snapshots and shared colors/selection in WASM. */
export class RustKernels {
  private readonly endpoints: (Float32Array | undefined)[] = [undefined, undefined];
  private recentSlot = 0;
  private retainedColors: LineColors | null = null;
  private retainedSelection: Uint8Array | null = null;
  private copiedBytes = 0;
  private constructor(private readonly exports: KernelExports) {}

  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }
  get copiedInputBytes(): number {
    return this.copiedBytes;
  }

  private copyInput(kind: KernelBuffer, source: ArrayBufferView, byteOffset = 0): void {
    const kernel = this.exports;
    new Uint8Array(kernel.memory.buffer, kernel.buffer(kind) + byteOffset, source.byteLength).set(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    );
    this.copiedBytes += source.byteLength;
  }

  createHistogram(): number {
    return this.exports.create_histogram();
  }
  releaseHistogram(slot: number): void {
    this.exports.release_histogram(slot);
  }

  /** Borrowed views: upload or copy these before the next kernel call can grow memory. */
  packHistogram(histogram: ContinuousHistogram, extra: boolean, slot: number, reset: boolean) {
    const kernel = this.exports;
    const stride = histogram.bins + 1;
    const cells = stride * stride;
    if (
      !Number.isSafeInteger(histogram.bins) ||
      histogram.bins < 0 ||
      [
        histogram.selected,
        histogram.context,
        histogram.color0,
        histogram.color1,
        histogram.color2,
        histogram.minimum,
        histogram.maximum,
      ].some((column) => column.length !== cells)
    )
      throw new Error("Histogram columns must match the declared square grid");
    // Sparse grids marshal occupied values; dense grids copy contiguous planes.
    const compact = histogram.occupied.length <= 512;
    const sourceCells = compact ? histogram.occupied.length : cells;
    const loadCells = kernel.prepare_histogram(
      slot,
      stride,
      histogram.occupied.length,
      Number(extra),
      Number(reset),
      Number(compact),
    );
    const copyCounts = (source: Uint32Array, plane: number): void =>
      this.copyInput(
        KernelBuffer.HistogramCounts,
        compact ? Uint32Array.from(histogram.occupied, (cell) => source[cell]) : source,
        sourceCells * plane * 4,
      );
    const copyColors = (source: Float64Array, plane: number): void =>
      this.copyInput(
        KernelBuffer.HistogramColors,
        compact ? Float64Array.from(histogram.occupied, (cell) => source[cell]) : source,
        sourceCells * plane * 8,
      );
    copyCounts(histogram.selected, 0);
    copyCounts(histogram.context, 1);
    copyColors(histogram.color0, 0);
    copyColors(histogram.color1, 1);
    if (extra) {
      copyCounts(histogram.minimum, 2);
      copyCounts(histogram.maximum, 3);
      copyColors(histogram.color2, 2);
    }
    if (loadCells) this.copyInput(KernelBuffer.HistogramCells, histogram.occupied);
    const changed = kernel.pack_histogram();
    return {
      counts: new Float32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.PackedCounts),
        cells * 4,
      ),
      extra: new Float32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.PackedExtra),
        extra ? cells * 4 : 4,
      ),
      dirtyRows: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.DirtyRows),
        changed,
      ),
    };
  }

  static create(): RustKernels | null {
    if (typeof WebAssembly === "undefined") return null;
    const bytes = Uint8Array.from(atob(embedded), (character) => character.charCodeAt(0));
    try {
      const module = new WebAssembly.Module(bytes);
      return new RustKernels(new WebAssembly.Instance(module).exports as KernelExports);
    } catch (error) {
      if (error instanceof WebAssembly.CompileError) return null;
      throw error;
    }
  }

  numericIndex(values: Float64Array, missing: Uint8Array) {
    if (values.length !== missing.length)
      throw new Error("Numeric values and missing flags must align");
    const kernel = this.exports;
    this.retainedSelection = null;
    kernel.prepare_numeric(values.length);
    this.copyInput(KernelBuffer.Values, values);
    this.copyInput(KernelBuffer.Selection, missing);
    const comparable = kernel.sort_numeric();
    const present = kernel.present_count();
    // Copies outlive workspace reuse and can be transferred independently of WASM memory.
    return {
      kind: "numeric" as const,
      comparable,
      order: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.Order),
        present,
      ).slice(),
      missing: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.Missing),
        values.length - present,
      ).slice(),
      values: new Float64Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.Sorted),
        present,
      ).slice(),
    };
  }

  categoricalIndex(codes: Int32Array, categories: readonly string[]) {
    const starts = new Uint32Array(categories.length + 1);
    let units = 0;
    for (let code = 0; code < categories.length; ++code) {
      starts[code] = units;
      units += categories[code].length;
    }
    starts[categories.length] = units;
    const text = new Uint16Array(units);
    for (let code = 0; code < categories.length; ++code)
      for (let unit = 0; unit < categories[code].length; ++unit)
        text[starts[code] + unit] = categories[code].charCodeAt(unit);
    const kernel = this.exports;
    kernel.prepare_categorical(codes.length, categories.length, units);
    this.copyInput(KernelBuffer.Codes, codes);
    this.copyInput(KernelBuffer.CategoryText, text);
    this.copyInput(KernelBuffer.CategoryStarts, starts);
    const groups = kernel.group_categorical();
    const present = kernel.present_count();
    const representatives = new Uint32Array(
      kernel.memory.buffer,
      kernel.buffer(KernelBuffer.CategoryValues),
      groups,
    );
    return {
      kind: "categorical" as const,
      order: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.Order),
        present,
      ).slice(),
      missing: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.Missing),
        codes.length - present,
      ).slice(),
      values: Array.from(representatives, (code) => categories[code]),
      offsets: new Uint32Array(
        kernel.memory.buffer,
        kernel.buffer(KernelBuffer.CategoryOffsets),
        groups + 1,
      ).slice(),
    };
  }

  marginal(
    marginal: ContinuousMarginal,
    colors: LineColors,
    height: number,
    lineWidth: number,
    mode: "mean" | "lowest" | "highest",
    pixelRatio = 1,
  ): ContinuousPixel[] {
    const rows = marginal.pixels.length;
    if (marginal.selection.length !== rows || colors.bins.length !== rows)
      throw new Error("Marginal endpoints, selection and colors must align");
    let slot = this.endpoints.indexOf(marginal.pixels);
    if (slot < 0) {
      slot = this.endpoints.indexOf(undefined);
      if (slot < 0) slot = 1 - this.recentSlot;
    }
    const paletteChannels = colors.colorMapBins === 0 ? colors.palette.length * 3 : 0;
    const kernel = this.exports;
    kernel.prepare(rows, height, paletteChannels, slot);
    if (this.endpoints[slot] !== marginal.pixels) {
      this.copyInput(KernelBuffer.Endpoints, marginal.pixels);
      this.endpoints[slot] = marginal.pixels;
    }
    this.recentSlot = slot;
    if (this.retainedSelection !== marginal.selection) {
      this.copyInput(KernelBuffer.Selection, marginal.selection);
      this.retainedSelection = marginal.selection;
    }
    if (this.retainedColors !== colors) {
      this.copyInput(KernelBuffer.Ranks, colors.bins);
      if (paletteChannels > 0) {
        this.copyInput(
          KernelBuffer.PaletteSource,
          Float64Array.from(colors.palette.flatMap(({ r, g, b }) => [r, g, b])),
        );
        kernel.quantize_palette();
      }
      this.retainedColors = colors;
    }
    kernel.reduce_marginal(
      height,
      lineWidth,
      colors.colorMapBins,
      { mean: 0, lowest: 1, highest: 2 }[mode],
      pixelRatio,
    );
    // Pixel is repr(C), with these nine f64 fields. No WASM views escape workspace reuse.
    const reduced = new Float64Array(
      kernel.memory.buffer,
      kernel.buffer(KernelBuffer.Statistics),
      height * 9,
    );
    return Array.from({ length: height }, (_, y) => {
      const offset = y * 9;
      return {
        selected: reduced[offset],
        context: reduced[offset + 1],
        selectedPeak: reduced[offset + 2],
        contextPeak: reduced[offset + 3],
        color0: reduced[offset + 4],
        color1: reduced[offset + 5],
        color2: reduced[offset + 6],
        winner: reduced[offset + 7],
        winnerCoverage: reduced[offset + 8],
      };
    });
  }
}

let kernels: RustKernels | null | undefined;
export function rustKernels(): RustKernels | null {
  if (kernels === undefined) kernels = RustKernels.create();
  return kernels;
}

/** Does not initialize a kernel merely to collect memory diagnostics. */
export function rustMemoryBytes(): number {
  return kernels?.memoryBytes ?? 0;
}
