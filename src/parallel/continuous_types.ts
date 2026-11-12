import type { LineColors, LineFrame } from "./webgl";

export const MIN_DENSITY_BINS = 256;
export const MAX_DENSITY_BINS = 1024;
export const EMPTY_COLOR_KEY = 0xffffffff;
export const COLOR_CHANNEL_SCALE = 65535;

export function continuousAxisBins(height: number): number {
  return Math.max(MIN_DENSITY_BINS, Math.min(MAX_DENSITY_BINS, Math.ceil(height)));
}

/** Fixed pair storage, excluding occupied-cell indexes, row links and raster images. */
export function continuousHistogramMinimumBytes(axes: number, height: number): number {
  const pairs = axes === 0 ? 0 : axes + 1;
  const cells = (continuousAxisBins(height) + 1) ** 2;
  // Selected/context counts, three color sums, and min/max ranks with multiplicities.
  const bytesPerCell =
    2 * Uint32Array.BYTES_PER_ELEMENT +
    3 * Float64Array.BYTES_PER_ELEMENT +
    4 * Uint32Array.BYTES_PER_ELEMENT;
  return pairs * cells * bytesPerCell;
}

export interface ContinuousColumn {
  id: number;
  pixels: Float32Array;
}

export interface ContinuousAxis {
  column: number;
  x: number;
}

export interface ContinuousRequest extends Omit<LineFrame, "axes"> {
  id: number;
  axes: readonly ContinuousAxis[];
  columns: readonly ContinuousColumn[];
  colors?: LineColors;
  selection?: Uint8Array;
}

/** Integer-valued sums in Float64 remain exact under both addition and subtraction. */
export interface ContinuousHistogram {
  bins: number;
  selected: Uint32Array;
  context: Uint32Array;
  color0: Float64Array;
  color1: Float64Array;
  color2: Float64Array;
  minimum: Uint32Array;
  maximum: Uint32Array;
  /** Canonical cells occupied by any source row, independent of selection. */
  occupied: Uint32Array;
  revision: number;
}

/** Immutable worker-owned endpoint and mask snapshots for exact outer-axis marginals. */
export interface ContinuousMarginal {
  pixels: Float32Array;
  selection: Uint8Array;
  revision: number;
}

export interface ContinuousPair {
  key: string;
  left: ContinuousAxis;
  right: ContinuousAxis;
  histogram: ContinuousHistogram;
  marginal?: ContinuousMarginal;
}

export interface ContinuousUpdate {
  pairs: readonly ContinuousPair[];
  colors: LineColors;
  rows: number;
  selectedCount: number;
  contextCount: number;
  changedRows: number;
  countMs: number;
  axisBins: number;
}

export interface ContinuousImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  milliseconds: number;
  countMs: number;
  rasterMs: number;
  rows: number;
  axisBins: number;
  evaluatedColumns: number;
  evaluatedPairs: number;
  /** Worker-reported WASM linear memory, separate from the browser's JS heap metric. */
  wasmMemoryBytes?: number;
}
