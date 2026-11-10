import type { ColorMode, RGB } from "../lib/colors";
import type { LineColors } from "./webgl";

/** Bounded geometry, independent of the number of source rows. */
export const MAX_AXIS_BINS = 512;
export const DEFAULT_AXIS_BINS = 256;
export const MAX_RASTER_CELLS = 4096;

export interface BinnedColumn {
  id: number;
  pixels: Float32Array;
}

export interface BinnedAxis {
  column: number;
  x: number;
}

export interface BinnedHistogram {
  bins: number;
  /** Both-missing rows are counted, but cannot consume the drawable-cell budget. */
  cells: number[];
  selected: Float64Array;
  context: Float64Array;
  selectedLeft: Float64Array;
  selectedRight: Float64Array;
  contextLeft: Float64Array;
  contextRight: Float64Array;
  color0: Float64Array;
  color1: Float64Array;
  color2: Float64Array;
  minimum: Float64Array;
  maximum: Float64Array;
}

export interface BinnedFrame {
  width: number;
  height: number;
  lineWidth: number;
  stubWidth?: number;
  axes: readonly BinnedAxis[];
  contextColor: RGB;
  contextAlpha: number;
  colorMode: ColorMode;
}

export interface BinnedRequest extends BinnedFrame {
  id: number;
  columns: readonly BinnedColumn[];
  colors?: LineColors;
  selection?: Uint8Array;
  /** Source rows represented by each deterministically sampled preview row. */
  rowWeight?: number;
}

export interface BinnedImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  milliseconds: number;
  countMs: number;
  rasterMs: number;
  sampledRows: number;
  sourceRows: number;
  axisBins: number;
}

/** Missing coordinates have their own bin, distinct from every finite value. */
export function quantizeColumn(
  pixels: Float32Array,
  height: number,
  maxBins = DEFAULT_AXIS_BINS,
): Uint16Array {
  const bins = Math.min(MAX_AXIS_BINS, maxBins, Math.max(1, Math.ceil(height)));
  const quantized = new Uint16Array(pixels.length);
  for (let row = 0; row < pixels.length; ++row) {
    const pixel = pixels[row];
    quantized[row] = Number.isFinite(pixel)
      ? Math.min(bins - 1, Math.max(0, Math.floor((pixel * bins) / Math.max(1, height))))
      : bins;
  }
  return quantized;
}

/** Counts all rows, retaining geometry means and the statistics needed by every color mode. */
export function buildPairHistogram(
  left: Float32Array,
  right: Float32Array,
  selection: Uint8Array,
  colors: LineColors,
  height: number,
  maxBins = DEFAULT_AXIS_BINS,
  leftBins = quantizeColumn(left, height, maxBins),
  rightBins = quantizeColumn(right, height, maxBins),
): BinnedHistogram {
  if (
    right.length !== left.length ||
    selection.length !== left.length ||
    colors.bins.length !== left.length
  ) {
    throw new Error("Binned columns, selection and colors must identify the same rows");
  }
  const bins = Math.min(MAX_AXIS_BINS, maxBins, Math.max(1, Math.ceil(height)));
  const histogram = emptyHistogram(bins);
  const valueColors = colors.colorMapBins > 0;
  for (let row = 0; row < left.length; ++row) {
    const cell = leftBins[row] * (bins + 1) + rightBins[row];
    const yLeft = Number.isFinite(left[row]) ? left[row] : 0;
    const yRight = Number.isFinite(right[row]) ? right[row] : 0;
    if (selection[row] === 0) {
      histogram.context[cell] += 1;
      histogram.contextLeft[cell] += yLeft;
      histogram.contextRight[cell] += yRight;
      continue;
    }
    histogram.selected[cell] += 1;
    histogram.selectedLeft[cell] += yLeft;
    histogram.selectedRight[cell] += yRight;
    const bin = colors.bins[row];
    if (valueColors) {
      if (bin < colors.colorMapBins) {
        const value = bin / Math.max(1, colors.colorMapBins - 1);
        histogram.color0[cell] += value;
        histogram.minimum[cell] = Math.min(histogram.minimum[cell], value);
        histogram.maximum[cell] = Math.max(histogram.maximum[cell], value);
      } else {
        histogram.color1[cell] += 1;
      }
    } else {
      const color = colors.palette[bin];
      if (color === undefined) {
        throw new Error(`Unknown binned palette entry ${bin}`);
      }
      histogram.color0[cell] += color.r / 255;
      histogram.color1[cell] += color.g / 255;
      histogram.color2[cell] += color.b / 255;
    }
  }
  histogram.cells = occupiedCells(histogram);
  return histogram;
}

function emptyHistogram(bins: number): BinnedHistogram {
  const size = (bins + 1) ** 2;
  return {
    bins,
    cells: [],
    selected: new Float64Array(size),
    context: new Float64Array(size),
    selectedLeft: new Float64Array(size),
    selectedRight: new Float64Array(size),
    contextLeft: new Float64Array(size),
    contextRight: new Float64Array(size),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Float64Array(size).fill(Number.POSITIVE_INFINITY),
    maximum: new Float64Array(size).fill(Number.NEGATIVE_INFINITY),
  };
}

function occupiedCells(histogram: BinnedHistogram): number[] {
  const cells: number[] = [];
  // Canonical endpoint order makes raster accumulation independent of first-occurrence row order.
  for (let cell = 0; cell < histogram.selected.length - 1; ++cell) {
    if (histogram.selected[cell] > 0 || histogram.context[cell] > 0) cells.push(cell);
  }
  return cells;
}

/** Merge neighboring endpoint cells, never transfer their mass to unrelated representatives. */
export function rasterHistogram(histogram: BinnedHistogram): BinnedHistogram {
  if (histogram.cells.length <= MAX_RASTER_CELLS) return histogram;
  const sourceStride = histogram.bins + 1;
  const mapping = new Uint32Array(histogram.cells.length + 1);
  let bins = histogram.bins;
  let occupied = histogram.cells.length;
  while (occupied > MAX_RASTER_CELLS) {
    bins = Math.max(
      1,
      Math.min(bins - 1, Math.floor(bins * Math.sqrt(MAX_RASTER_CELLS / occupied))),
    );
    const stride = bins + 1;
    const seen = new Uint8Array(stride ** 2);
    occupied = 0;
    for (let index = 0; index < histogram.cells.length; ++index) {
      const cell = histogram.cells[index];
      const left = Math.floor(cell / sourceStride);
      const right = cell % sourceStride;
      // The missing bin maps to the missing bin, never to a finite endpoint.
      const target =
        Math.floor((left * bins) / histogram.bins) * stride +
        Math.floor((right * bins) / histogram.bins);
      mapping[index] = target;
      if (seen[target] === 0) {
        seen[target] = 1;
        occupied += 1;
      }
    }
  }
  const raster = emptyHistogram(bins);
  mapping[histogram.cells.length] = raster.selected.length - 1;
  for (let index = 0; index <= histogram.cells.length; ++index) {
    const cell =
      index === histogram.cells.length ? histogram.selected.length - 1 : histogram.cells[index];
    const target = mapping[index];
    for (const statistic of [
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
      raster[statistic][target] += histogram[statistic][cell];
    }
    raster.minimum[target] = Math.min(raster.minimum[target], histogram.minimum[cell]);
    raster.maximum[target] = Math.max(raster.maximum[target], histogram.maximum[cell]);
  }
  raster.cells = occupiedCells(raster);
  return raster;
}

/** Area-conserving major-axis box coverage: bounded work without per-fragment integrals. */
function rasterSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
  lineWidth: number,
  put: (pixel: number, coverage: number) => void,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const major0 = horizontal ? x0 : y0;
  const major1 = horizontal ? x1 : y1;
  const minor0 = horizontal ? y0 : x0;
  const minorDelta = horizontal ? dy : dx;
  const majorDelta = major1 - major0;
  const majorLimit = horizontal ? width : height;
  const minorLimit = horizontal ? height : width;
  const footprint = (Math.max(1, lineWidth) * length) / Math.abs(majorDelta);
  const radius = footprint / 2;
  const start = Math.max(0, Math.ceil(Math.min(major0, major1) - 0.5));
  const end = Math.min(majorLimit, Math.ceil(Math.max(major0, major1) - 0.5));
  for (let major = start; major < end; ++major) {
    const t = (major + 0.5 - major0) / majorDelta;
    const center = minor0 + t * minorDelta;
    const first = Math.max(0, Math.floor(center - radius));
    const last = Math.min(minorLimit - 1, Math.ceil(center + radius) - 1);
    for (let minor = first; minor <= last; ++minor) {
      const x = horizontal ? major : minor;
      const y = horizontal ? minor : major;
      const along = ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / (length * length);
      if (along < 0 || along >= 1) continue;
      const coverage =
        (Math.min(minor + 1, center + radius) - Math.max(minor, center - radius)) *
        Math.min(lineWidth, 1);
      if (coverage > 0) put(y * width + x, coverage);
    }
  }
}

function colorMapAt(colors: LineColors, value: number): RGB {
  const position = Math.max(0, Math.min(1, value)) * (colors.colorMapBins - 1);
  const below = Math.floor(position);
  const above = Math.min(below + 1, colors.colorMapBins - 1);
  const fraction = position - below;
  const left = colors.palette[below];
  const right = colors.palette[above];
  return {
    r: (left.r + (right.r - left.r) * fraction) / 255,
    g: (left.g + (right.g - left.g) * fraction) / 255,
    b: (left.b + (right.b - left.b) * fraction) / 255,
  };
}

/** Tone mapping uses row counts, never the number of occupied histogram cells. */
function toneMapped(sum: number, peak: number, reference: number): number {
  if (peak <= 0) return 0;
  return peak * Math.min(1, Math.log1p(sum / peak) / Math.log1p(reference));
}

export interface BinnedPair {
  left: BinnedAxis;
  right: BinnedAxis;
  histogram: BinnedHistogram;
}

/** CPU raster cost is bounded by occupied cells and visible pixels rather than source rows. */
export function rasterizeHistograms(
  frame: BinnedFrame,
  pairs: readonly BinnedPair[],
  colors: LineColors,
  selectedCount: number,
  contextCount: number,
  rowWeight = 1,
): Pick<BinnedImage, "pixels" | "width" | "height"> {
  const width = Math.max(1, Math.ceil(frame.width));
  const height = Math.max(1, Math.ceil(frame.height));
  const size = width * height;
  const selected = new Float64Array(size);
  const context = new Float64Array(size);
  const selectedPeak = new Float64Array(size);
  const contextPeak = new Float64Array(size);
  const color0 = new Float64Array(size);
  const color1 = new Float64Array(size);
  const color2 = new Float64Array(size);
  const winningValue = new Float64Array(size).fill(
    frame.colorMode === "lowest" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
  );
  const winningCoverage = new Float64Array(size);
  const valueColors = colors.colorMapBins > 0;
  const withWinner = valueColors && frame.colorMode !== "mean";
  const stubWidth = frame.stubWidth ?? 15;
  for (const { left, right, histogram: source } of pairs) {
    if (Math.max(left.x, right.x) + stubWidth < 0 || Math.min(left.x, right.x) - stubWidth > width)
      continue;
    const histogram = rasterHistogram(source);
    const stride = histogram.bins + 1;
    for (const cell of histogram.cells) {
      const hasLeft = Math.floor(cell / stride) !== histogram.bins;
      const hasRight = cell % stride !== histogram.bins;
      if (!hasLeft && !hasRight) continue;
      for (const isSelected of [true, false]) {
        const count = isSelected ? histogram.selected[cell] : histogram.context[cell];
        if (count === 0) continue;
        const leftSum = isSelected ? histogram.selectedLeft[cell] : histogram.contextLeft[cell];
        const rightSum = isSelected ? histogram.selectedRight[cell] : histogram.contextRight[cell];
        const yLeft = hasLeft ? leftSum / count : rightSum / count;
        const yRight = hasRight ? rightSum / count : leftSum / count;
        const xLeft = hasLeft ? left.x : right.x - stubWidth;
        const xRight = hasRight ? right.x : left.x + stubWidth;
        const extreme =
          frame.colorMode === "lowest" ? histogram.minimum[cell] : histogram.maximum[cell];
        rasterSegment(
          xLeft,
          yLeft,
          xRight,
          yRight,
          width,
          height,
          frame.lineWidth,
          (pixel, covered) => {
            const weightedCoverage = covered * rowWeight;
            if (!isSelected) {
              context[pixel] += count * weightedCoverage;
              contextPeak[pixel] = Math.max(contextPeak[pixel], covered);
              return;
            }
            selected[pixel] += count * weightedCoverage;
            selectedPeak[pixel] = Math.max(selectedPeak[pixel], covered);
            color0[pixel] += histogram.color0[cell] * weightedCoverage;
            color1[pixel] += histogram.color1[cell] * weightedCoverage;
            color2[pixel] += histogram.color2[cell] * weightedCoverage;
            if (!withWinner || !Number.isFinite(extreme)) return;
            const previous = winningValue[pixel];
            if (
              (frame.colorMode === "lowest" && extreme < previous) ||
              (frame.colorMode === "highest" && extreme > previous)
            ) {
              winningValue[pixel] = extreme;
              winningCoverage[pixel] = covered;
            } else if (extreme === previous) {
              winningCoverage[pixel] = Math.max(winningCoverage[pixel], covered);
            }
          },
        );
      }
    }
  }
  const pixels = new Uint8ClampedArray(size * 4);
  const selectedReference = Math.max(
    2,
    (12 * selectedCount * rowWeight) / Math.max(1, frame.height),
  );
  const contextReference = Math.max(2, (12 * contextCount * rowWeight) / Math.max(1, frame.height));
  const missing = colors.palette[colors.colorMapBins];
  for (let pixel = 0; pixel < size; ++pixel) {
    const selectedAlpha = toneMapped(selected[pixel], selectedPeak[pixel], selectedReference);
    const contextAlpha =
      frame.contextAlpha * toneMapped(context[pixel], contextPeak[pixel], contextReference);
    const alpha = selectedAlpha + contextAlpha * (1 - selectedAlpha);
    if (alpha === 0) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    if (selected[pixel] > 0) {
      if (valueColors) {
        const missingShare = color1[pixel] / selected[pixel];
        const valued = selected[pixel] - color1[pixel];
        const mean = valued > 0 ? colorMapAt(colors, color0[pixel] / valued) : { r: 0, g: 0, b: 0 };
        r = mean.r * (1 - missingShare) + (missing.r / 255) * missingShare;
        g = mean.g * (1 - missingShare) + (missing.g / 255) * missingShare;
        b = mean.b * (1 - missingShare) + (missing.b / 255) * missingShare;
        if (withWinner && winningCoverage[pixel] > 0) {
          const winner = colorMapAt(colors, winningValue[pixel]);
          const share = Math.min(1, winningCoverage[pixel] / selectedPeak[pixel]);
          r += (winner.r - r) * share;
          g += (winner.g - g) * share;
          b += (winner.b - b) * share;
        }
      } else {
        r = color0[pixel] / selected[pixel];
        g = color1[pixel] / selected[pixel];
        b = color2[pixel] / selected[pixel];
      }
    }
    // RGBA8 is unpremultiplied, as ImageData and the foreground image texture expect.
    const contextShare = contextAlpha * (1 - selectedAlpha);
    pixels[pixel * 4] =
      (255 * (r * selectedAlpha + (frame.contextColor.r / 255) * contextShare)) / alpha;
    pixels[pixel * 4 + 1] =
      (255 * (g * selectedAlpha + (frame.contextColor.g / 255) * contextShare)) / alpha;
    pixels[pixel * 4 + 2] =
      (255 * (b * selectedAlpha + (frame.contextColor.b / 255) * contextShare)) / alpha;
    pixels[pixel * 4 + 3] = alpha * 255;
  }
  return { pixels, width, height };
}

interface CachedColumn {
  pixels: Float32Array;
  bins: Uint16Array;
}

/** Worker-owned columns and pair counts survive scrolling and unchanged adjacencies. */
export class BinnedKernel {
  private columns = new Map<number, CachedColumn>();
  private pairs = new Map<string, BinnedHistogram>();
  private colors: LineColors | null = null;
  private selection: Uint8Array | null = null;
  private height = Number.NaN;
  private selectedCount = 0;
  private missingColumn: CachedColumn | null = null;

  constructor(private readonly maxAxisBins = DEFAULT_AXIS_BINS) {}

  render(request: BinnedRequest): BinnedImage {
    const started = performance.now();
    if (request.height !== this.height) {
      this.height = request.height;
      this.pairs.clear();
      for (const column of this.columns.values()) {
        column.bins = quantizeColumn(column.pixels, request.height, this.maxAxisBins);
      }
    }
    for (const column of request.columns) {
      this.columns.set(column.id, {
        pixels: column.pixels,
        bins: quantizeColumn(column.pixels, request.height, this.maxAxisBins),
      });
    }
    if (request.colors !== undefined) {
      this.colors = request.colors;
      this.pairs.clear();
    }
    if (request.selection !== undefined) {
      this.selection = request.selection;
      this.selectedCount = 0;
      for (const value of this.selection) this.selectedCount += value === 0 ? 0 : 1;
      this.pairs.clear();
    }
    const { colors, selection } = this;
    if (colors === null || selection === null)
      throw new Error("Binned worker needs colors and selection before rendering");
    if (this.missingColumn === null || this.missingColumn.pixels.length !== selection.length) {
      const pixels = new Float32Array(selection.length).fill(Number.NaN);
      this.missingColumn = {
        pixels,
        bins: quantizeColumn(pixels, request.height, this.maxAxisBins),
      };
    } else {
      this.missingColumn.bins.fill(
        Math.min(MAX_AXIS_BINS, this.maxAxisBins, Math.max(1, Math.ceil(request.height))),
      );
    }
    const axes = request.axes;
    const stubWidth = request.stubWidth ?? 15;
    const drawnPairs: BinnedPair[] = [];
    const activePairs = new Set<string>();
    for (let pair = 0; pair <= axes.length; ++pair) {
      if (axes.length === 0) break;
      const left = pair > 0 ? axes[pair - 1] : { column: -1, x: axes[0].x - stubWidth };
      const right =
        pair < axes.length ? axes[pair] : { column: -1, x: axes[axes.length - 1].x + stubWidth };
      const leftColumn = left.column === -1 ? this.missingColumn : this.columns.get(left.column);
      const rightColumn = right.column === -1 ? this.missingColumn : this.columns.get(right.column);
      if (leftColumn === undefined || rightColumn === undefined)
        throw new Error("Unknown binned axis column");
      const key = `${left.column}:${right.column}`;
      activePairs.add(key);
      let histogram = this.pairs.get(key);
      if (histogram === undefined) {
        histogram = buildPairHistogram(
          leftColumn.pixels,
          rightColumn.pixels,
          selection,
          colors,
          request.height,
          this.maxAxisBins,
          leftColumn.bins,
          rightColumn.bins,
        );
        histogram = rasterHistogram(histogram);
        this.pairs.set(key, histogram);
      }
      drawnPairs.push({ left, right, histogram });
    }
    for (const key of this.pairs.keys()) if (!activePairs.has(key)) this.pairs.delete(key);
    const activeColumns = new Set(axes.map((axis) => axis.column));
    for (const column of this.columns.keys())
      if (!activeColumns.has(column)) this.columns.delete(column);
    const counted = performance.now();
    const image = rasterizeHistograms(
      request,
      drawnPairs,
      colors,
      this.selectedCount,
      selection.length - this.selectedCount,
      request.rowWeight,
    );
    const finished = performance.now();
    return {
      ...image,
      milliseconds: finished - started,
      countMs: counted - started,
      rasterMs: finished - counted,
      sampledRows: selection.length,
      sourceRows: selection.length * (request.rowWeight ?? 1),
      axisBins: Math.min(MAX_AXIS_BINS, this.maxAxisBins, Math.max(1, Math.ceil(request.height))),
    };
  }
}
