import type { LineColors, LineFrame } from "./webgl";

export const MIN_DENSITY_BINS = 256;
export const MAX_DENSITY_BINS = 1024;
export const EMPTY_COLOR_KEY = 0xffffffff;
export const COLOR_CHANNEL_SCALE = 65535;

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

export interface ContinuousPair {
  key: string;
  left: ContinuousAxis;
  right: ContinuousAxis;
  histogram: ContinuousHistogram;
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
}
