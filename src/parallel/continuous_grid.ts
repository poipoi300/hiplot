import {
  COLOR_CHANNEL_SCALE,
  type ContinuousAxis,
  type ContinuousHistogram,
  type ContinuousPair,
  type ContinuousRequest,
  type ContinuousUpdate,
  EMPTY_COLOR_KEY,
  MAX_DENSITY_BINS,
  MIN_DENSITY_BINS,
} from "./continuous_types";
import type { LineColors } from "./webgl";

interface CachedColumn {
  pixels: Float32Array;
  bins: Uint16Array;
}

interface CachedPair {
  leftColumn: number;
  rightColumn: number;
  histogram: ContinuousHistogram & ExtremaMultiplicities;
  cells: Uint32Array;
  heads: Uint32Array;
  next: Uint32Array;
}

interface MaskScratch {
  touched: Uint32Array;
  state: Uint8Array;
  selected: Uint32Array;
  color0: Float64Array;
  color1: Float64Array;
  color2: Float64Array;
  minimum: Uint32Array;
  maximum: Uint32Array;
}

function maskScratch(size: number): MaskScratch {
  return {
    touched: new Uint32Array(size),
    state: new Uint8Array(size),
    selected: new Uint32Array(size),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size),
    maximum: new Uint32Array(size),
  };
}

type FixedPalette = readonly (readonly [number, number, number])[];
interface ExtremaMultiplicities {
  minimumCount: Uint32Array;
  maximumCount: Uint32Array;
}
type ColorStatistics = Pick<
  ContinuousHistogram,
  "color0" | "color1" | "color2" | "minimum" | "maximum"
> &
  ExtremaMultiplicities;

function quantize(pixels: Float32Array, height: number, bins: number): Uint16Array {
  const quantized = new Uint16Array(pixels.length);
  for (let row = 0; row < pixels.length; ++row) {
    const pixel = pixels[row];
    quantized[row] = Number.isFinite(pixel)
      ? Math.max(0, Math.min(bins - 1, Math.round((pixel / height) * (bins - 1))))
      : bins;
  }
  return quantized;
}

function emptyColorStatistics(size: number): ColorStatistics {
  return {
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    maximum: new Uint32Array(size).fill(EMPTY_COLOR_KEY),
    minimumCount: new Uint32Array(size),
    maximumCount: new Uint32Array(size),
  };
}

function emptyHistogram(bins: number): ContinuousHistogram & ExtremaMultiplicities {
  const size = (bins + 1) ** 2;
  return {
    bins,
    selected: new Uint32Array(size),
    context: new Uint32Array(size),
    ...emptyColorStatistics(size),
    occupied: new Uint32Array(),
    revision: 0,
  };
}

function validateColors(colors: LineColors, rows: number): void {
  const { colorMapBins, palette } = colors;
  if (
    !Number.isInteger(colorMapBins) ||
    colorMapBins < 0 ||
    colorMapBins > EMPTY_COLOR_KEY ||
    (colorMapBins > 0 && palette.length <= colorMapBins)
  ) {
    throw new Error("Continuous colors need a valid color map and missing-color palette entry");
  }
  if (rows * Math.max(0, colorMapBins - 1) > Number.MAX_SAFE_INTEGER) {
    throw new Error("Continuous numeric color sums exceed the exact integer range");
  }
  for (const color of palette) {
    if (
      color === undefined ||
      ![color.r, color.g, color.b].every(
        (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255,
      )
    ) {
      throw new Error("Continuous palette channels must be finite values from 0 to 255");
    }
  }
  for (const rank of colors.bins) {
    if (rank >= palette.length || (colorMapBins > 0 && rank > colorMapBins)) {
      throw new Error(`Unknown continuous palette rank ${rank}`);
    }
  }
}

function fixedPalette(colors: LineColors): FixedPalette {
  if (colors.colorMapBins > 0) return [];
  return colors.palette.map(({ r, g, b }) => [
    Math.round((r / 255) * COLOR_CHANNEL_SCALE),
    Math.round((g / 255) * COLOR_CHANNEL_SCALE),
    Math.round((b / 255) * COLOR_CHANNEL_SCALE),
  ]);
}

function addColor(
  histogram: ColorStatistics,
  cell: number,
  rank: number,
  colors: LineColors,
  palette: FixedPalette,
  direction: 1 | -1,
): void {
  if (colors.colorMapBins === 0) {
    const [r, g, b] = palette[rank];
    histogram.color0[cell] += direction * r;
    histogram.color1[cell] += direction * g;
    histogram.color2[cell] += direction * b;
    return;
  }
  if (rank === colors.colorMapBins) {
    histogram.color1[cell] += direction;
    return;
  }
  histogram.color0[cell] += direction * rank;
  if (direction < 0) {
    if (rank === histogram.minimum[cell]) histogram.minimumCount[cell] -= 1;
    if (rank === histogram.maximum[cell]) histogram.maximumCount[cell] -= 1;
    return;
  }
  if (rank < histogram.minimum[cell]) {
    histogram.minimum[cell] = rank;
    histogram.minimumCount[cell] = 1;
  } else if (rank === histogram.minimum[cell]) {
    histogram.minimumCount[cell] += 1;
  }
  if (histogram.maximum[cell] === EMPTY_COLOR_KEY || rank > histogram.maximum[cell]) {
    histogram.maximum[cell] = rank;
    histogram.maximumCount[cell] = 1;
  } else if (rank === histogram.maximum[cell]) {
    histogram.maximumCount[cell] += 1;
  }
}

/**
 * All rows count, including both-missing cells and the two outer stub pairs.
 * Counts support at most 2^32 - 1 rows. Categorical sums are bounded by
 * (2^32 - 1) * 65535 < 2^48; numeric sums require rows * (colorMapBins - 1)
 * <= 2^53 - 1. Integer additions and removals are therefore exact in Float64.
 * Supplied buffers are snapshotted; omitted active columns/colors/selection retain state.
 * changedRows counts mask differences (all rows on first initialization).
 */
export class ContinuousKernel {
  private columns = new Map<number, CachedColumn>();
  private pairs = new Map<string, CachedPair>();
  private colors: LineColors | null = null;
  private palette: FixedPalette = [];
  private selection: Uint8Array | null = null;
  private selectedCount = 0;
  private height = Number.NaN;
  private revision = 0;
  private marginalRevision = 0;
  private maskScratch: MaskScratch | null = null;

  update(request: ContinuousRequest): ContinuousUpdate {
    const started = performance.now();
    const colors = request.colors ?? this.colors;
    const selection = request.selection ?? this.selection;
    if (colors === null || selection === null) {
      throw new Error("Continuous kernel needs colors and selection before counting");
    }
    const rows = colors.bins.length;
    if (rows > EMPTY_COLOR_KEY) {
      throw new Error("Continuous counts exceed the Uint32 row limit");
    }
    if (selection.length !== rows) {
      throw new Error("Continuous columns, selection and colors must identify the same rows");
    }
    if (!Number.isFinite(request.height) || request.height <= 0) {
      throw new Error("Continuous axis height must be finite and positive");
    }
    if (request.colors !== undefined) validateColors(colors, rows);
    const resetRows = this.selection === null || this.selection.length !== rows;
    const replacements = new Map<number, Float32Array>();
    for (const column of request.columns) {
      if (!Number.isSafeInteger(column.id) || column.id < 0 || replacements.has(column.id)) {
        throw new Error("Continuous column IDs must be unique nonnegative safe integers");
      }
      if (column.pixels.length !== rows) {
        throw new Error("Continuous columns, selection and colors must identify the same rows");
      }
      replacements.set(column.id, column.pixels);
    }
    for (const axis of request.axes) {
      if (!Number.isFinite(axis.x)) throw new Error("Continuous axis positions must be finite");
      if (!replacements.has(axis.column) && (resetRows || !this.columns.has(axis.column))) {
        throw new Error(`Unknown continuous axis column ${axis.column}`);
      }
    }
    const changed = new Uint32Array(request.selection === undefined && !resetRows ? 0 : rows);
    let changedRows = 0;
    let selectedCount = this.selectedCount;
    if (request.selection !== undefined || resetRows) {
      selectedCount = 0;
      for (let row = 0; row < rows; ++row) {
        const value = selection[row];
        if (value !== 0 && value !== 1) {
          throw new Error("Continuous selection masks must contain only 0 or 1");
        }
        selectedCount += value;
        if (resetRows || value !== this.selection?.[row]) changed[changedRows++] = row;
      }
    }

    const bins = Math.max(MIN_DENSITY_BINS, Math.min(MAX_DENSITY_BINS, Math.ceil(request.height)));
    const resized = this.height !== request.height;
    if (resetRows) this.columns.clear();
    const activeColumns = new Set(request.axes.map((axis) => axis.column));
    for (const id of this.columns.keys()) {
      if (!activeColumns.has(id)) this.columns.delete(id);
    }
    if (resetRows || resized) this.pairs.clear();
    if (resized) {
      for (const [id, column] of this.columns) {
        if (!replacements.has(id)) column.bins = quantize(column.pixels, request.height, bins);
      }
    }
    for (const [id, pixels] of replacements) {
      if (!activeColumns.has(id)) continue;
      const ownedPixels = pixels.slice();
      this.columns.set(id, {
        pixels: ownedPixels,
        bins: quantize(ownedPixels, request.height, bins),
      });
    }
    for (const [key, pair] of this.pairs) {
      if (replacements.has(pair.leftColumn) || replacements.has(pair.rightColumn)) {
        this.pairs.delete(key);
      }
    }
    this.height = request.height;
    this.selectedCount = selectedCount;
    const currentSelection =
      request.selection === undefined && !resetRows ? selection : selection.slice();
    const currentColors =
      request.colors === undefined
        ? colors
        : {
            bins: colors.bins.slice(),
            palette: colors.palette.map((color) => ({ ...color })),
            colorMapBins: colors.colorMapBins,
          };
    this.selection = currentSelection;
    this.colors = currentColors;
    if (request.colors !== undefined) this.palette = fixedPalette(currentColors);

    if (
      resetRows ||
      resized ||
      replacements.size > 0 ||
      changedRows > 0 ||
      request.colors !== undefined
    )
      this.marginalRevision++;
    const drawnPairs: ContinuousPair[] = [];
    const activePairs = new Set<string>();
    for (let index = 0; request.axes.length > 0 && index <= request.axes.length; ++index) {
      const left: ContinuousAxis =
        index === 0 ? { column: -1, x: request.axes[0].x - 15 } : { ...request.axes[index - 1] };
      const right: ContinuousAxis =
        index === request.axes.length
          ? { column: -1, x: request.axes[index - 1].x + 15 }
          : { ...request.axes[index] };
      const key = `${left.column}:${right.column}`;
      let pair = this.pairs.get(key);
      if (pair === undefined) {
        pair = this.buildPair(left.column, right.column, bins, currentSelection, currentColors);
        pair.histogram.revision = ++this.revision;
        this.pairs.set(key, pair);
      } else if (!activePairs.has(key)) {
        if (request.colors !== undefined) {
          if (this.recolor(pair, currentSelection, currentColors, changed, changedRows)) {
            pair.histogram.revision = ++this.revision;
          }
        } else if (changedRows > 0) {
          if (this.updateMask(pair, currentSelection, currentColors, changed, changedRows)) {
            pair.histogram.revision = ++this.revision;
          }
        }
      }
      activePairs.add(key);
      const endpoint = this.columns.get(left.column === -1 ? right.column : left.column);
      drawnPairs.push({
        key,
        left,
        right,
        histogram: pair.histogram,
        marginal:
          (left.column === -1 || right.column === -1) && endpoint !== undefined
            ? {
                pixels: endpoint.pixels,
                selection: currentSelection,
                revision: this.marginalRevision,
              }
            : undefined,
      });
    }
    for (const key of this.pairs.keys()) {
      if (!activePairs.has(key)) this.pairs.delete(key);
    }
    return {
      pairs: drawnPairs,
      colors: currentColors,
      rows,
      selectedCount,
      contextCount: rows - selectedCount,
      changedRows,
      countMs: performance.now() - started,
      axisBins: bins,
    };
  }

  private buildPair(
    leftColumn: number,
    rightColumn: number,
    bins: number,
    selection: Uint8Array,
    colors: LineColors,
  ): CachedPair {
    const histogram = emptyHistogram(bins);
    const cells = new Uint32Array(selection.length);
    const heads = new Uint32Array(histogram.selected.length).fill(EMPTY_COLOR_KEY);
    const next = new Uint32Array(selection.length);
    const leftBins = this.columns.get(leftColumn)?.bins;
    const rightBins = this.columns.get(rightColumn)?.bins;
    for (let row = 0; row < selection.length; ++row) {
      const cell = (leftBins?.[row] ?? bins) * (bins + 1) + (rightBins?.[row] ?? bins);
      cells[row] = cell;
      next[row] = heads[cell];
      heads[cell] = row;
      if (selection[row] === 0) {
        histogram.context[cell] += 1;
      } else {
        histogram.selected[cell] += 1;
        addColor(histogram, cell, colors.bins[row], colors, this.palette, 1);
      }
    }
    const occupied: number[] = [];
    for (let cell = 0; cell < heads.length; ++cell) {
      if (heads[cell] !== EMPTY_COLOR_KEY) occupied.push(cell);
    }
    histogram.occupied = Uint32Array.from(occupied);
    return { leftColumn, rightColumn, histogram, cells, heads, next };
  }

  private updateMask(
    pair: CachedPair,
    selection: Uint8Array,
    colors: LineColors,
    changed: Uint32Array,
    changedRows: number,
  ): boolean {
    const histogram = pair.histogram;
    const size = (histogram.bins + 1) ** 2;
    if (this.maskScratch === null || this.maskScratch.state.length < size) {
      this.maskScratch = maskScratch(size);
    }
    const before = this.maskScratch;
    let touchedCount = 0;
    for (let index = 0; index < changedRows; ++index) {
      const row = changed[index];
      const cell = pair.cells[row];
      if (before.state[cell] === 0) {
        // Snapshots occupy a dense prefix; only membership flags are indexed by cell.
        before.touched[touchedCount] = cell;
        before.selected[touchedCount] = histogram.selected[cell];
        before.color0[touchedCount] = histogram.color0[cell];
        before.color1[touchedCount] = histogram.color1[cell];
        before.color2[touchedCount] = histogram.color2[cell];
        before.minimum[touchedCount] = histogram.minimum[cell];
        before.maximum[touchedCount] = histogram.maximum[cell];
        before.state[cell] = 1;
        ++touchedCount;
      }
      const rank = colors.bins[row];
      const direction = selection[row] === 0 ? -1 : 1;
      histogram.selected[cell] += direction;
      histogram.context[cell] -= direction;
      addColor(histogram, cell, rank, colors, this.palette, direction);
    }
    let differs = false;
    for (let index = 0; index < touchedCount; ++index) {
      const cell = before.touched[index];
      if (colors.colorMapBins > 0) {
        if (histogram.selected[cell] === histogram.color1[cell]) {
          histogram.minimum[cell] = EMPTY_COLOR_KEY;
          histogram.maximum[cell] = EMPTY_COLOR_KEY;
          histogram.minimumCount[cell] = 0;
          histogram.maximumCount[cell] = 0;
        } else if (histogram.minimumCount[cell] === 0 || histogram.maximumCount[cell] === 0) {
          // Apply the whole batch first: an exchange can restore an exhausted extreme.
          this.rescanExtrema(pair, cell, selection, colors);
        }
      }
      // Every pair shares this scratch, including cells with cancelling deltas.
      before.state[cell] = 0;
      if (
        histogram.selected[cell] !== before.selected[index] ||
        histogram.color0[cell] !== before.color0[index] ||
        histogram.color1[cell] !== before.color1[index] ||
        histogram.color2[cell] !== before.color2[index] ||
        histogram.minimum[cell] !== before.minimum[index] ||
        histogram.maximum[cell] !== before.maximum[index]
      ) {
        differs = true;
      }
    }
    return differs;
  }

  private rescanExtrema(
    pair: CachedPair,
    cell: number,
    selection: Uint8Array,
    colors: LineColors,
  ): void {
    let minimum = EMPTY_COLOR_KEY;
    let maximum = EMPTY_COLOR_KEY;
    let minimumCount = 0;
    let maximumCount = 0;
    for (let row = pair.heads[cell]; row !== EMPTY_COLOR_KEY; row = pair.next[row]) {
      const rank = colors.bins[row];
      if (selection[row] === 0 || rank >= colors.colorMapBins) continue;
      if (rank < minimum) {
        minimum = rank;
        minimumCount = 1;
      } else if (rank === minimum) {
        ++minimumCount;
      }
      if (maximum === EMPTY_COLOR_KEY || rank > maximum) {
        maximum = rank;
        maximumCount = 1;
      } else if (rank === maximum) {
        ++maximumCount;
      }
    }
    pair.histogram.minimum[cell] = minimum;
    pair.histogram.maximum[cell] = maximum;
    pair.histogram.minimumCount[cell] = minimumCount;
    pair.histogram.maximumCount[cell] = maximumCount;
  }

  private recolor(
    pair: CachedPair,
    selection: Uint8Array,
    colors: LineColors,
    changed: Uint32Array,
    changedRows: number,
  ): boolean {
    const histogram = pair.histogram;
    const statistics = emptyColorStatistics(histogram.selected.length);
    for (let row = 0; row < selection.length; ++row) {
      if (selection[row] === 1) {
        addColor(statistics, pair.cells[row], colors.bins[row], colors, this.palette, 1);
      }
    }
    // Count differences can cancel within a cell, just as color differences can.
    const countDeltas = new Map<number, number>();
    for (let index = 0; index < changedRows; ++index) {
      const row = changed[index];
      const cell = pair.cells[row];
      const direction = selection[row] === 0 ? -1 : 1;
      countDeltas.set(cell, (countDeltas.get(cell) ?? 0) + direction);
    }
    let differs = false;
    for (const [cell, delta] of countDeltas) {
      histogram.selected[cell] += delta;
      histogram.context[cell] -= delta;
      if (delta !== 0) differs = true;
    }
    for (const name of ["color0", "color1", "color2", "minimum", "maximum"] as const) {
      if (!differs) {
        for (const cell of histogram.occupied) {
          if (histogram[name][cell] !== statistics[name][cell]) {
            differs = true;
            break;
          }
        }
      }
    }
    Object.assign(histogram, statistics);
    return differs;
  }
}
