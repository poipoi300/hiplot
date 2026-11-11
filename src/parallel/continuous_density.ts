import type { RGB } from "../lib/colors";
import { CONTINUOUS_CURVE_GLSL, continuousCurve } from "./continuous_curve";
import {
  type ContinuousReconstructionPlan,
  continuousReconstructionNeedsRefinement,
  continuousReconstructionPlan,
  reconstructContinuousPair,
} from "./continuous_reconstruction";
import { ContinuousWebGLReconstruction } from "./continuous_reconstruction_gl";
import {
  COLOR_CHANNEL_SCALE,
  type ContinuousHistogram,
  type ContinuousImage,
  type ContinuousMarginal,
  type ContinuousPair,
  type ContinuousRequest,
  type ContinuousUpdate,
  EMPTY_COLOR_KEY,
} from "./continuous_types";
import { densityReference, type LineColors } from "./webgl";

/** Sparse grids query every intersecting occupied cell; dense grids reconstruct the field. */
export const SPARSE_DENSITY_CELLS = 512;
export const DENSITY_TILE_ROWS = 16;

export interface SparseDensityIndex {
  indices: Uint32Array;
  ranges: Uint32Array;
  tiles: number;
}

/** CSR pixel-tile index: reject only geometrically disjoint strips, never occupied cells. */
export function continuousSparseIndex(
  histogram: ContinuousHistogram,
  style: DensityStyle,
  gap: number,
  columns: number,
  height: number,
  cells = histogram.occupied,
): SparseDensityIndex {
  const tiles = Math.ceil(height / DENSITY_TILE_ROWS);
  const starts = new Int32Array(columns * cells.length).fill(-1);
  const ends = new Int32Array(starts.length);
  const counts = new Uint32Array(columns * tiles);
  const spacing = style.height / (histogram.bins - 1);
  const stride = histogram.bins + 1;
  for (let x = 0; x < columns; ++x) {
    const position = ((x + 0.5) * gap) / columns;
    const t = position / gap;
    const [weight, derivative] = style.curved ? continuousCurve(t) : [t, 1];
    for (let index = 0; index < cells.length; ++index) {
      const left = Math.floor(cells[index] / stride);
      const right = cells[index] % stride;
      if (left === histogram.bins && right === histogram.bins) continue;
      if (
        (left === histogram.bins && position < gap - 15) ||
        (right === histogram.bins && position >= 15)
      )
        continue;
      const missing = left === histogram.bins || right === histogram.bins;
      const center = missing
        ? (left === histogram.bins ? right : left) * spacing
        : ((1 - weight) * left + weight * right) * spacing;
      const slope = missing ? 0 : (derivative * (right - left) * spacing) / gap;
      const radius =
        Math.max(style.lineWidth / 2, 0.5) * Math.hypot(1, slope) + (1 + Math.abs(slope)) / 2;
      // Whole-pixel outward rounding also includes float-roundoff at tile boundaries.
      const first = Math.max(0, Math.floor(center - radius - 0.5));
      const last = Math.min(height - 1, Math.ceil(center + radius - 0.5));
      if (first > last) continue;
      const start = Math.floor(first / DENSITY_TILE_ROWS);
      const end = Math.floor(last / DENSITY_TILE_ROWS);
      starts[x * cells.length + index] = start;
      ends[x * cells.length + index] = end;
      for (let tile = start; tile <= end; ++tile) counts[tile * columns + x]++;
    }
  }
  const ranges = new Uint32Array(counts.length * 2);
  let total = 0;
  for (let bucket = 0; bucket < counts.length; ++bucket) {
    ranges[bucket * 2] = total;
    total += counts[bucket];
    ranges[bucket * 2 + 1] = total;
  }
  const indices = new Uint32Array(total);
  counts.fill(0);
  for (let x = 0; x < columns; ++x) {
    for (let index = 0; index < cells.length; ++index) {
      const start = starts[x * cells.length + index];
      if (start < 0) continue;
      const end = ends[x * cells.length + index];
      for (let tile = start; tile <= end; ++tile) {
        const bucket = tile * columns + x;
        indices[ranges[bucket * 2] + counts[bucket]++] = cells[index];
      }
    }
  }
  return { indices, ranges, tiles };
}

export interface ContinuousPixel {
  selected: number;
  context: number;
  selectedPeak: number;
  contextPeak: number;
  color0: number;
  color1: number;
  color2: number;
  winner: number;
  winnerCoverage: number;
}

type DensityStyle = Pick<ContinuousRequest, "height" | "lineWidth" | "curved" | "colorMode">;

interface SparseDensityLayers {
  selected: boolean;
  context: boolean;
  cells: Uint32Array;
}

function sparseDensityLayers(histogram: ContinuousHistogram): SparseDensityLayers {
  let selectedCount = 0;
  let contextCount = 0;
  for (const cell of histogram.occupied) {
    if (histogram.selected[cell] > 0) selectedCount++;
    if (histogram.context[cell] > 0) contextCount++;
  }
  const selected = selectedCount <= SPARSE_DENSITY_CELLS;
  const context = contextCount <= SPARSE_DENSITY_CELLS;
  const cells: number[] = [];
  for (const cell of histogram.occupied) {
    if ((selected && histogram.selected[cell] > 0) || (context && histogram.context[cell] > 0))
      cells.push(cell);
  }
  return { selected, context, cells: Uint32Array.from(cells) };
}

function squareBelow(position: number, narrow: number, wide: number): number {
  const outer = (narrow + wide) / 2;
  const inner = (wide - narrow) / 2;
  if (position <= -outer) return 0;
  if (position >= outer) return 1;
  if (position < -inner) return (position + outer) ** 2 / (2 * narrow * wide);
  if (position <= inner) return 0.5 + position / wide;
  return 1 - (outer - position) ** 2 / (2 * narrow * wide);
}

/** Same normalized, exact square/strip intersection used by the exact line renderer. */
export function continuousStripCoverage(
  distanceY: number,
  slope: number,
  lineWidth: number,
): number {
  const length = Math.hypot(1, slope);
  const narrow = Math.min(1, Math.abs(slope)) / length;
  const wide = Math.max(1, Math.abs(slope)) / length;
  const halfWidth = Math.max(lineWidth / 2, 0.5);
  const across = distanceY / length;
  const center = squareBelow(halfWidth, narrow, wide) - squareBelow(-halfWidth, narrow, wide);
  return Math.max(
    0,
    ((squareBelow(across + halfWidth, narrow, wide) -
      squareBelow(across - halfWidth, narrow, wide)) /
      center) *
      Math.min(lineWidth, 1),
  );
}

function emptyPixel(): ContinuousPixel {
  return {
    selected: 0,
    context: 0,
    selectedPeak: 0,
    contextPeak: 0,
    color0: 0,
    color1: 0,
    color2: 0,
    winner: EMPTY_COLOR_KEY,
    winnerCoverage: 0,
  };
}

function addCell(
  output: ContinuousPixel,
  histogram: ContinuousHistogram,
  cell: number,
  weight: number,
  coverage: number,
  colorMode: ContinuousRequest["colorMode"],
  selectedLayer: boolean,
  contextLayer: boolean,
): void {
  if (weight <= 0) return;
  const selected = selectedLayer ? histogram.selected[cell] : 0;
  const context = contextLayer ? histogram.context[cell] : 0;
  output.selected += selected * weight;
  output.context += context * weight;
  if (selectedLayer) {
    output.color0 += histogram.color0[cell] * weight;
    output.color1 += histogram.color1[cell] * weight;
    output.color2 += histogram.color2[cell] * weight;
  }
  if (selected > 0) output.selectedPeak = Math.max(output.selectedPeak, coverage);
  if (context > 0) output.contextPeak = Math.max(output.contextPeak, coverage);
  if (selected === 0 || coverage <= 0 || colorMode === "mean") return;
  const key = colorMode === "lowest" ? histogram.minimum[cell] : histogram.maximum[cell];
  if (key === EMPTY_COLOR_KEY) return;
  if (
    output.winner === EMPTY_COLOR_KEY ||
    (colorMode === "lowest" ? key < output.winner : key > output.winner)
  ) {
    output.winner = key;
    output.winnerCoverage = coverage;
  } else if (key === output.winner) {
    output.winnerCoverage = Math.max(output.winnerCoverage, coverage);
  }
}

/**
 * CPU reference for the fragment evaluator. x and y are pair-local CSS pixel centers.
 * Missing endpoints are finite-endpoint, 15 CSS pixel horizontal stubs.
 */
export function evaluateContinuousPixel(
  histogram: ContinuousHistogram,
  style: DensityStyle,
  gap: number,
  x: number,
  y: number,
  sparse?: boolean,
): ContinuousPixel {
  const layers = sparseDensityLayers(histogram);
  if (sparse !== undefined) layers.selected = layers.context = sparse;
  return evaluatePixelLayers(histogram, style, gap, x, y, layers, histogram.occupied);
}

function evaluatePixelLayers(
  histogram: ContinuousHistogram,
  style: DensityStyle,
  gap: number,
  x: number,
  y: number,
  layers: SparseDensityLayers,
  candidates: Uint32Array,
  firstCandidate = 0,
  lastCandidate = candidates.length,
): ContinuousPixel {
  const output = emptyPixel();
  if (gap <= 0 || x < 0 || x >= gap) return output;
  const { bins } = histogram;
  const stride = bins + 1;
  const spacing = style.height / (bins - 1);
  const t = x / gap;
  const [w, derivative] = style.curved ? continuousCurve(t) : [t, 1];
  const exact = (left: number, right: number, cell: number, sparsePhase: boolean): void => {
    if (left === bins && right === bins) return;
    if ((left === bins && x < gap - 15) || (right === bins && x >= 15)) return;
    const missing = left === bins || right === bins;
    const center = missing
      ? (left === bins ? right : left) * spacing
      : ((1 - w) * left + w * right) * spacing;
    const slope = missing ? 0 : (derivative * (right - left) * spacing) / gap;
    const coverage = continuousStripCoverage(y - center, slope, style.lineWidth);
    addCell(
      output,
      histogram,
      cell,
      coverage,
      coverage,
      style.colorMode,
      layers.selected === sparsePhase,
      layers.context === sparsePhase,
    );
  };
  if (layers.selected || layers.context) {
    for (let index = firstCandidate; index < lastCandidate; ++index) {
      const cell = candidates[index];
      exact(Math.floor(cell / stride), cell % stride, cell, true);
    }
  }
  if (layers.selected && layers.context) return output;
  const reverse = w < 0.5;
  const weight = reverse ? 1 - w : w;
  for (let a = 0; a < bins; ++a) {
    const b = (y / spacing - (1 - weight) * a) / weight;
    const radius = 0.5 / (weight * spacing);
    // Integrate the reconstructed field over the vertical pixel footprint before tone mapping.
    const first = Math.max(0, Math.ceil(b - radius - 1));
    const last = Math.min(bins - 1, Math.floor(b + radius + 1));
    for (let endpoint = first; endpoint <= last; ++endpoint) {
      const interpolation =
        (endpointTentIntegral(b + radius - endpoint) -
          endpointTentIntegral(b - radius - endpoint)) /
        (2 * radius);
      const left = reverse ? endpoint : a;
      const right = reverse ? a : endpoint;
      const center = ((1 - w) * left + w * right) * spacing;
      const localSlope = (derivative * (right - left) * spacing) / gap;
      const factor =
        (style.lineWidth * Math.hypot(1, localSlope)) /
        (weight * spacing * stripCenterCoverage(localSlope, style.lineWidth));
      // Dense bins reconstruct a continuous endpoint interval, not coincident bin-center lines.
      const distance = Math.max(0, Math.abs(y - center) - spacing / 2);
      const coverage = continuousStripCoverage(distance, localSlope, style.lineWidth);
      addCell(
        output,
        histogram,
        left * stride + right,
        interpolation * factor,
        coverage,
        style.colorMode,
        !layers.selected,
        !layers.context,
      );
    }
    exact(a, bins, a * stride + bins, false);
    exact(bins, a, bins * stride + a, false);
  }
  return output;
}

/** Integral of the endpoint's linear tent basis from minus infinity to position. */
function endpointTentIntegral(position: number): number {
  if (position <= -1) return 0;
  if (position >= 1) return 1;
  return position < 0 ? (position + 1) ** 2 / 2 : 1 - (1 - position) ** 2 / 2;
}

function stripCenterCoverage(slope: number, lineWidth: number): number {
  const length = Math.hypot(1, slope);
  const narrow = Math.min(1, Math.abs(slope)) / length;
  const wide = Math.max(1, Math.abs(slope)) / length;
  const halfWidth = Math.max(lineWidth / 2, 0.5);
  return squareBelow(halfWidth, narrow, wide) - squareBelow(-halfWidth, narrow, wide);
}

function toneMapped(sum: number, peak: number, reference: number): number {
  if (sum <= 0 || peak <= 0) return 0;
  return peak * Math.min(1, Math.log1p(sum / peak) / Math.log1p(reference));
}

function paletteAt(colors: LineColors, rank: number): RGB {
  const position = Math.max(0, Math.min(colors.colorMapBins - 1, rank));
  const below = Math.floor(position);
  const fraction = position - below;
  const left = colors.palette[below];
  const right = colors.palette[Math.min(below + 1, colors.colorMapBins - 1)];
  return {
    r: left.r + (right.r - left.r) * fraction,
    g: left.g + (right.g - left.g) * fraction,
    b: left.b + (right.b - left.b) * fraction,
  };
}

/** Returns unpremultiplied RGBA in [0, 1], preserving selected-over-context. */
export function compositeContinuousPixel(
  pixel: ContinuousPixel,
  frame: Pick<ContinuousRequest, "height" | "contextColor" | "contextAlpha" | "colorMode">,
  colors: LineColors,
  selectedCount: number,
  contextCount: number,
): readonly [number, number, number, number] {
  const selectedAlpha = toneMapped(
    pixel.selected,
    pixel.selectedPeak,
    densityReference(selectedCount, frame.height),
  );
  const contextAlpha =
    frame.contextAlpha *
    toneMapped(pixel.context, pixel.contextPeak, densityReference(contextCount, frame.height));
  const contextShare = contextAlpha * (1 - selectedAlpha);
  const alpha = selectedAlpha + contextShare;
  if (alpha <= 0) return [0, 0, 0, 0];
  let rgb: RGB = { r: 0, g: 0, b: 0 };
  if (pixel.selected > 0) {
    if (colors.colorMapBins > 0) {
      const valued = Math.max(0, pixel.selected - pixel.color1);
      const mean = valued > 0 ? paletteAt(colors, pixel.color0 / valued) : rgb;
      const missing = colors.palette[colors.colorMapBins];
      const missingShare = pixel.color1 / pixel.selected;
      rgb = {
        r: mean.r * (1 - missingShare) + missing.r * missingShare,
        g: mean.g * (1 - missingShare) + missing.g * missingShare,
        b: mean.b * (1 - missingShare) + missing.b * missingShare,
      };
      if (
        frame.colorMode !== "mean" &&
        pixel.winner !== EMPTY_COLOR_KEY &&
        pixel.selectedPeak > 0
      ) {
        const winner = paletteAt(colors, pixel.winner);
        const share = Math.min(1, pixel.winnerCoverage / pixel.selectedPeak);
        rgb = {
          r: rgb.r + (winner.r - rgb.r) * share,
          g: rgb.g + (winner.g - rgb.g) * share,
          b: rgb.b + (winner.b - rgb.b) * share,
        };
      }
    } else {
      const divisor = pixel.selected * COLOR_CHANNEL_SCALE;
      rgb = {
        r: (pixel.color0 / divisor) * 255,
        g: (pixel.color1 / divisor) * 255,
        b: (pixel.color2 / divisor) * 255,
      };
    }
  }
  return [
    (rgb.r * selectedAlpha + frame.contextColor.r * contextShare) / (255 * alpha),
    (rgb.g * selectedAlpha + frame.contextColor.g * contextShare) / (255 * alpha),
    (rgb.b * selectedAlpha + frame.contextColor.b * contextShare) / (255 * alpha),
    alpha,
  ];
}

export interface ContinuousPairImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** When present, pixels is selected-only; reconstruct both layers before compositing. */
  contextPixels?: Uint8ClampedArray;
}

// Fixed subpixel geometry prevents translation cancellation from invalidating pair-local caches.
function pairGap(pair: ContinuousPair): number {
  return Math.round((pair.right.x - pair.left.x) * 65536) / 65536;
}

/** Reduce original endpoints once, preserving the exact flat outer-strip footprint. */
function evaluateContinuousMarginal(
  marginal: ContinuousMarginal,
  frame: ContinuousRequest,
  update: ContinuousUpdate,
  columns: number,
  separateLayers: boolean,
): ContinuousPairImage {
  const height = Math.max(1, Math.ceil(frame.height));
  const rows = Array.from({ length: height }, emptyPixel);
  const { colors } = update;
  const palette =
    colors.colorMapBins === 0
      ? colors.palette.map(({ r, g, b }) =>
          [r, g, b].map((channel) => Math.round((channel / 255) * COLOR_CHANNEL_SCALE)),
        )
      : [];
  const halfWidth = Math.max(frame.lineWidth / 2, 0.5);
  const lineScale = Math.min(frame.lineWidth, 1);
  for (let row = 0; row < marginal.pixels.length; ++row) {
    const endpoint = marginal.pixels[row];
    if (!Number.isFinite(endpoint)) continue;
    const rank = colors.bins[row];
    const selected = marginal.selection[row] !== 0;
    const first = Math.max(0, Math.ceil(endpoint - halfWidth - 1));
    const last = Math.min(height - 1, Math.floor(endpoint + halfWidth));
    for (let y = first; y <= last; ++y) {
      // The square/strip intersection for a horizontal tangent has a unit central plateau.
      const coverage =
        Math.min(1, Math.max(0, halfWidth + 0.5 - Math.abs(y + 0.5 - endpoint))) * lineScale;
      if (coverage <= 0) continue;
      const pixel = rows[y];
      if (!selected) {
        pixel.context += coverage;
        pixel.contextPeak = Math.max(pixel.contextPeak, coverage);
        continue;
      }
      pixel.selected += coverage;
      pixel.selectedPeak = Math.max(pixel.selectedPeak, coverage);
      if (colors.colorMapBins === 0) {
        pixel.color0 += palette[rank][0] * coverage;
        pixel.color1 += palette[rank][1] * coverage;
        pixel.color2 += palette[rank][2] * coverage;
      } else if (rank === colors.colorMapBins) {
        pixel.color1 += coverage;
      } else {
        pixel.color0 += rank * coverage;
        if (frame.colorMode !== "mean") {
          if (
            pixel.winner === EMPTY_COLOR_KEY ||
            (frame.colorMode === "lowest" ? rank < pixel.winner : rank > pixel.winner)
          ) {
            pixel.winner = rank;
            pixel.winnerCoverage = coverage;
          } else if (rank === pixel.winner)
            pixel.winnerCoverage = Math.max(pixel.winnerCoverage, coverage);
        }
      }
    }
  }
  const pixels = new Uint8ClampedArray(columns * height * 4);
  const contextPixels = separateLayers ? new Uint8ClampedArray(pixels.length) : undefined;
  const selectedFrame = separateLayers ? { ...frame, contextAlpha: 0 } : frame;
  const contextReference = densityReference(update.contextCount, frame.height);
  for (let y = 0; y < height; ++y) {
    const pixel = rows[y];
    const rgba = compositeContinuousPixel(
      pixel,
      selectedFrame,
      colors,
      update.selectedCount,
      update.contextCount,
    );
    for (let x = 0; x < columns; ++x) {
      const offset = (y * columns + x) * 4;
      for (let channel = 0; channel < 4; ++channel) pixels[offset + channel] = rgba[channel] * 255;
      if (contextPixels !== undefined) {
        contextPixels.set(
          [
            frame.contextColor.r,
            frame.contextColor.g,
            frame.contextColor.b,
            255 *
              frame.contextAlpha *
              toneMapped(pixel.context, pixel.contextPeak, contextReference),
          ],
          offset,
        );
      }
    }
  }
  return { pixels, width: columns, height, contextPixels };
}

/** Evaluate all pixels without a GL context; also serves as the browser GPU reference. */
export function evaluateContinuousPairCPU(
  pair: ContinuousPair,
  frame: ContinuousRequest,
  update: ContinuousUpdate,
  columns = Math.max(1, Math.ceil(pairGap(pair))),
  separateLayers = false,
): ContinuousPairImage {
  if (pair.marginal !== undefined)
    return evaluateContinuousMarginal(pair.marginal, frame, update, columns, separateLayers);
  const height = Math.max(1, Math.ceil(frame.height));
  const pixels = new Uint8ClampedArray(columns * height * 4);
  const contextPixels = separateLayers ? new Uint8ClampedArray(pixels.length) : undefined;
  const selectedFrame = separateLayers ? { ...frame, contextAlpha: 0 } : frame;
  const contextReference = densityReference(update.contextCount, frame.height);
  const gap = pairGap(pair);
  const layers = sparseDensityLayers(pair.histogram);
  const spatial = continuousSparseIndex(pair.histogram, frame, gap, columns, height, layers.cells);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < columns; ++x) {
      const bucket = (Math.floor(y / DENSITY_TILE_ROWS) * columns + x) * 2;
      const pixel = evaluatePixelLayers(
        pair.histogram,
        frame,
        gap,
        ((x + 0.5) * gap) / columns,
        y + 0.5,
        layers,
        spatial.indices,
        spatial.ranges[bucket],
        spatial.ranges[bucket + 1],
      );
      const rgba = compositeContinuousPixel(
        pixel,
        selectedFrame,
        update.colors,
        update.selectedCount,
        update.contextCount,
      );
      const offset = (y * columns + x) * 4;
      for (let channel = 0; channel < 4; ++channel) pixels[offset + channel] = rgba[channel] * 255;
      if (contextPixels !== undefined) {
        contextPixels[offset] = frame.contextColor.r;
        contextPixels[offset + 1] = frame.contextColor.g;
        contextPixels[offset + 2] = frame.contextColor.b;
        contextPixels[offset + 3] =
          255 * frame.contextAlpha * toneMapped(pixel.context, pixel.contextPeak, contextReference);
      }
    }
  }
  return { pixels, width: columns, height, contextPixels };
}

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_counts;
uniform sampler2D u_extra;
uniform highp usampler2D u_occupied;
uniform highp usampler2D u_ranges;
uniform sampler2D u_palette;
uniform int u_bins;
uniform int u_occupiedWidth;
uniform int u_colorMapBins;
uniform int u_mode;
uniform bool u_sparseSelected;
uniform bool u_sparseContext;
uniform bool u_curved;
uniform bool u_separateLayers;
uniform float u_height;
uniform float u_gap;
uniform float u_columns;
uniform float u_lineWidth;
uniform float u_selectedReference;
uniform float u_contextReference;
uniform vec3 u_contextColor;
uniform float u_contextAlpha;
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 contextLayer;
vec4 sums = vec4(0.0);
float color2 = 0.0;
vec2 peaks = vec2(0.0);
float winner = -1.0;
float winnerCoverage = 0.0;
${CONTINUOUS_CURVE_GLSL}
float squareBelow(float x, float narrow, float wide) {
  if (narrow == 0.0) return clamp(0.5 + x / wide, 0.0, 1.0);
  float outer = 0.5 * (narrow + wide);
  float inner = 0.5 * (wide - narrow);
  float clipped = clamp(x, -outer, outer);
  float corner = max(abs(clipped) - inner, 0.0);
  // The trapezoid CDF is its central ramp minus the outer triangular excess.
  return 0.5 + clipped / wide - sign(clipped) * corner * corner / (2.0 * narrow * wide);
}
float centerCoverage(float slope) {
  // halfWidth >= 0.5 lies beyond the trapezoid's inner corner. Its two omitted
  // corner triangles have total area excess^2 / abs(slope), in unnormalized units.
  float magnitude = abs(slope);
  float excess = max(0.0, 0.5 * (1.0 + magnitude) -
    max(u_lineWidth * 0.5, 0.5) * sqrt(1.0 + slope * slope));
  return excess <= 0.0 ? 1.0 : 1.0 - excess * excess / magnitude;
}
float stripCoverage(float distanceY, float slope) {
  float length = sqrt(1.0 + slope * slope);
  float narrow = min(1.0, abs(slope)) / length;
  float wide = max(1.0, abs(slope)) / length;
  float halfWidth = max(u_lineWidth * 0.5, 0.5);
  // Reject disjoint square/strip footprints before evaluating their intersection.
  if (abs(distanceY) >= halfWidth * length + 0.5 * (1.0 + abs(slope))) return 0.0;
  float across = distanceY / length;
  return max(0.0, (squareBelow(across + halfWidth, narrow, wide) -
    squareBelow(across - halfWidth, narrow, wide)) / centerCoverage(slope) * min(u_lineWidth, 1.0));
}
float endpointTentIntegral(float position) {
  if (position <= -1.0) return 0.0;
  if (position >= 1.0) return 1.0;
  return position < 0.0 ? 0.5 * (position + 1.0) * (position + 1.0) :
    1.0 - 0.5 * (1.0 - position) * (1.0 - position);
}
void addCell(ivec2 endpoint, float weight, float covered, bool sparsePhase) {
  if (weight <= 0.0) return;
  vec4 counts = texelFetch(u_counts, endpoint.yx, 0);
  bool selectedLayer = u_sparseSelected == sparsePhase;
  bool contextLayer = u_sparseContext == sparsePhase;
  if (!selectedLayer) counts.rba = vec3(0.0);
  if (!contextLayer) counts.g = 0.0;
  vec4 extra = vec4(0.0);
  if (selectedLayer && (u_colorMapBins == 0 || u_mode != 0))
    extra = texelFetch(u_extra, endpoint.yx, 0);
  sums += counts * weight;
  color2 += extra.r * weight;
  if (counts.r > 0.0) peaks.r = max(peaks.r, covered);
  if (counts.g > 0.0) peaks.g = max(peaks.g, covered);
  if (u_mode == 0 || counts.r <= 0.0 || covered <= 0.0) return;
  float key = u_mode == 1 ? extra.g : extra.b;
  if (key < 0.0) return;
  if (winner < 0.0 || (u_mode == 1 ? key < winner : key > winner)) {
    winner = key;
    winnerCoverage = covered;
  } else if (key == winner) winnerCoverage = max(winnerCoverage, covered);
}
void exactCell(ivec2 endpoint, float x, float y, float w, float derivative, float spacing, bool sparsePhase) {
  if (endpoint.x == u_bins && endpoint.y == u_bins) return;
  if ((endpoint.x == u_bins && x < u_gap - 15.0) || (endpoint.y == u_bins && x >= 15.0)) return;
  bool missing = endpoint.x == u_bins || endpoint.y == u_bins;
  float center = missing ? float(endpoint.x == u_bins ? endpoint.y : endpoint.x) * spacing :
    mix(float(endpoint.x), float(endpoint.y), w) * spacing;
  float slope = missing ? 0.0 : derivative * float(endpoint.y - endpoint.x) * spacing / u_gap;
  float covered = stripCoverage(y - center, slope);
  addCell(endpoint, covered, covered, sparsePhase);
}
float toneMapped(float sum, float peak, float reference) {
  if (sum <= 0.0 || peak <= 0.0) return 0.0;
  return peak * clamp(log(1.0 + sum / peak) / log(1.0 + reference), 0.0, 1.0);
}
vec3 paletteAt(int bin) { return texelFetch(u_palette, ivec2(bin, 0), 0).rgb; }
vec3 colorMapAt(float rank) {
  float position = clamp(rank, 0.0, float(u_colorMapBins - 1));
  int below = int(floor(position));
  return mix(paletteAt(below), paletteAt(min(below + 1, u_colorMapBins - 1)), fract(position));
}
void main() {
  contextLayer = vec4(0.0);
  float x = gl_FragCoord.x * u_gap / u_columns;
  // The FBO's low row deliberately stores the image's top row, as does the CPU reference.
  float y = gl_FragCoord.y;
  float t = x / u_gap;
  vec2 profile = u_curved ? continuousCurve(t) : vec2(t, 1.0);
  float w = profile.x;
  float derivative = profile.y;
  float spacing = u_height / float(u_bins - 1);
  if (u_sparseSelected || u_sparseContext) {
    uvec2 range = texelFetch(u_ranges,
      ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y) / ${DENSITY_TILE_ROWS}), 0).rg;
    for (int i = int(range.r); i < int(range.g); ++i) {
      uint cell = texelFetch(u_occupied, ivec2(i % u_occupiedWidth, i / u_occupiedWidth), 0).r;
      exactCell(ivec2(int(cell) / (u_bins + 1), int(cell) % (u_bins + 1)), x, y, w, derivative, spacing, true);
    }
  }
  if (!u_sparseSelected || !u_sparseContext) {
    bool reverse = w < 0.5;
    float weight = reverse ? 1.0 - w : w;
    for (int a = 0; a < u_bins; ++a) {
      float b = (y / spacing - (1.0 - weight) * float(a)) / weight;
      float radius = 0.5 / (weight * spacing);
      int first = max(0, int(ceil(b - radius - 1.0)));
      int last = min(u_bins - 1, int(floor(b + radius + 1.0)));
      for (int endpoint = first; endpoint <= last; ++endpoint) {
        float interpolation = (endpointTentIntegral(b + radius - float(endpoint)) -
          endpointTentIntegral(b - radius - float(endpoint))) / (2.0 * radius);
        ivec2 endpoints = reverse ? ivec2(endpoint, a) : ivec2(a, endpoint);
        float center = mix(float(endpoints.x), float(endpoints.y), w) * spacing;
        float localSlope = derivative * float(endpoints.y - endpoints.x) * spacing / u_gap;
        float factor = u_lineWidth * sqrt(1.0 + localSlope * localSlope) /
          (weight * spacing * centerCoverage(localSlope));
        float covered = stripCoverage(max(0.0, abs(y - center) - 0.5 * spacing), localSlope);
        addCell(endpoints, interpolation * factor, covered, false);
      }
    }
    // Horizontal missing-value stubs intersect only the bins inside this pixel's footprint.
    float radius = max(u_lineWidth * 0.5, 0.5) + 0.5;
    int firstStub = max(0, int(ceil((y - radius) / spacing)));
    int lastStub = min(u_bins - 1, int(floor((y + radius) / spacing)));
    for (int a = firstStub; a <= lastStub; ++a) {
      exactCell(ivec2(a, u_bins), x, y, w, derivative, spacing, false);
      exactCell(ivec2(u_bins, a), x, y, w, derivative, spacing, false);
    }
  }
  float selectedAlpha = toneMapped(sums.r, peaks.r, u_selectedReference);
  float contextAlpha = u_contextAlpha * toneMapped(sums.g, peaks.g, u_contextReference);
  float contextShare = contextAlpha * (1.0 - selectedAlpha);
  float alpha = selectedAlpha + contextShare;
  if (alpha <= 0.0) { color = vec4(0.0); return; }
  vec3 rgb = vec3(0.0);
  if (sums.r > 0.0) {
    if (u_colorMapBins > 0) {
      float valued = max(0.0, sums.r - sums.a);
      rgb = valued > 0.0 ? colorMapAt(sums.b / valued) : vec3(0.0);
      rgb = mix(rgb, paletteAt(u_colorMapBins), sums.a / sums.r);
      if (u_mode != 0 && winner >= 0.0 && peaks.r > 0.0)
        rgb = mix(rgb, colorMapAt(winner), min(1.0, winnerCoverage / peaks.r));
    } else rgb = vec3(sums.ba, color2) / (sums.r * ${COLOR_CHANNEL_SCALE}.0);
  }
  if (u_separateLayers) {
    color = vec4(rgb, selectedAlpha);
    contextLayer = vec4(u_contextColor, contextAlpha);
  } else color = vec4((rgb * selectedAlpha + u_contextColor * contextShare) / alpha, alpha);
}`;

/** Retained WebGL2 evaluator; only pair images, never source rows, leave this context. */
export class ContinuousWebGLEvaluator {
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[];
  private readonly framebuffer: WebGLFramebuffer;
  private readonly image: WebGLTexture;
  private readonly contextImage: WebGLTexture;
  private reconstruction: ContinuousWebGLReconstruction | null = null;
  private readonly uniforms = new Map<string, WebGLUniformLocation>();
  readonly software: boolean;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (shader === null) throw new Error("Cannot allocate continuous density shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Continuous density shader: ${message}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (program === null) throw new Error("Cannot allocate continuous density program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Continuous density link: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    const texture = (): WebGLTexture => {
      const result = gl.createTexture();
      if (result === null) throw new Error("Cannot allocate continuous density texture");
      return result;
    };
    this.textures = Array.from({ length: 5 }, texture);
    this.image = texture();
    this.contextImage = texture();
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error("Cannot allocate continuous density framebuffer");
    this.framebuffer = framebuffer;
    const diagnostic = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer =
      diagnostic === null ? "unknown" : String(gl.getParameter(diagnostic.UNMASKED_RENDERER_WEBGL));
    this.software = /unknown|swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  }

  private uniform(name: string): WebGLUniformLocation {
    let location = this.uniforms.get(name);
    if (location === undefined) {
      const found = this.gl.getUniformLocation(this.program, `u_${name}`);
      if (found === null) throw new Error(`Missing continuous density uniform ${name}`);
      location = found;
      this.uniforms.set(name, location);
    }
    return location;
  }

  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  evaluate(
    pair: ContinuousPair,
    frame: ContinuousRequest,
    update: ContinuousUpdate,
    columns: number,
    reconstruct = false,
    plan?: ContinuousReconstructionPlan,
  ): ContinuousPairImage {
    const { gl } = this;
    if (gl.isContextLost()) throw new Error("Continuous density WebGL context lost");
    if (pair.marginal !== undefined)
      return evaluateContinuousMarginal(pair.marginal, frame, update, columns, reconstruct);
    const height = Math.max(1, Math.ceil(frame.height));
    const histogram = pair.histogram;
    const stride = histogram.bins + 1;
    const maximumTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // Categorical RGB is already reduced into cell sums; no categorical lookup texture is needed.
    const paletteLength = update.colors.colorMapBins > 0 ? update.colors.palette.length : 1;
    if (Math.max(stride, columns, height, paletteLength) > maximumTexture)
      throw new Error("Continuous density image exceeds WebGL texture capacity");
    const counts = new Float32Array(stride * stride * 4);
    const needsExtra = update.colors.colorMapBins === 0 || frame.colorMode !== "mean";
    const extra = new Float32Array(needsExtra ? counts.length : 4);
    for (const cell of histogram.occupied) {
      const offset = cell * 4;
      counts[offset] = histogram.selected[cell];
      counts[offset + 1] = histogram.context[cell];
      counts[offset + 2] = histogram.color0[cell];
      counts[offset + 3] = histogram.color1[cell];
      if (needsExtra) {
        extra[offset] = histogram.color2[cell];
        extra[offset + 1] =
          histogram.minimum[cell] === EMPTY_COLOR_KEY ? -1 : histogram.minimum[cell];
        extra[offset + 2] =
          histogram.maximum[cell] === EMPTY_COLOR_KEY ? -1 : histogram.maximum[cell];
      }
    }
    const layers = sparseDensityLayers(histogram);
    const sparse = layers.selected || layers.context;
    const spatial = sparse
      ? continuousSparseIndex(histogram, frame, pairGap(pair), columns, height, layers.cells)
      : { indices: new Uint32Array(), ranges: new Uint32Array(2), tiles: 1 };
    const occupiedWidth = Math.max(1, Math.min(maximumTexture, spatial.indices.length));
    const occupiedHeight = Math.max(1, Math.ceil(spatial.indices.length / occupiedWidth));
    if (occupiedHeight > maximumTexture)
      throw new Error("Continuous density spatial index exceeds WebGL texture capacity");
    const occupied = new Uint32Array(occupiedWidth * occupiedHeight);
    occupied.set(spatial.indices);
    const palette = new Float32Array(paletteLength * 4);
    if (update.colors.colorMapBins > 0) {
      update.colors.palette.forEach((rgb, index) => {
        palette[index * 4] = rgb.r / 255;
        palette[index * 4 + 1] = rgb.g / 255;
        palette[index * 4 + 2] = rgb.b / 255;
        palette[index * 4 + 3] = 1;
      });
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    const upload = (
      unit: number,
      name: string,
      width: number,
      height: number,
      data: Float32Array | Uint32Array,
      components: 1 | 2 = 1,
    ): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
      const integer = data instanceof Uint32Array;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        integer ? (components === 2 ? gl.RG32UI : gl.R32UI) : gl.RGBA32F,
        width,
        height,
        0,
        integer ? (components === 2 ? gl.RG_INTEGER : gl.RED_INTEGER) : gl.RGBA,
        integer ? gl.UNSIGNED_INT : gl.FLOAT,
        data,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(this.uniform(name), unit);
    };
    upload(0, "counts", stride, stride, counts);
    upload(1, "extra", needsExtra ? stride : 1, needsExtra ? stride : 1, extra);
    upload(2, "occupied", occupiedWidth, occupiedHeight, occupied);
    upload(3, "palette", paletteLength, 1, palette);
    upload(4, "ranges", sparse ? columns : 1, spatial.tiles, spatial.ranges, 2);
    for (const [name, value] of Object.entries({
      bins: histogram.bins,
      occupiedWidth,
      colorMapBins: update.colors.colorMapBins,
      mode: { mean: 0, lowest: 1, highest: 2 }[frame.colorMode],
      sparseSelected: Number(layers.selected),
      sparseContext: Number(layers.context),
      curved: Number(frame.curved),
      separateLayers: Number(reconstruct),
    }))
      gl.uniform1i(this.uniform(name), value);
    for (const [name, value] of Object.entries({
      height: frame.height,
      gap: pairGap(pair),
      columns,
      lineWidth: frame.lineWidth,
      selectedReference: densityReference(update.selectedCount, frame.height),
      contextReference: densityReference(update.contextCount, frame.height),
      contextAlpha: frame.contextAlpha,
    }))
      gl.uniform1f(this.uniform(name), value);
    gl.uniform3f(
      this.uniform("contextColor"),
      frame.contextColor.r / 255,
      frame.contextColor.g / 255,
      frame.contextColor.b / 255,
    );
    // The output texture uses a separate unit so none of the input samplers alias it.
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, columns, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.image, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (reconstruct) {
      gl.activeTexture(gl.TEXTURE0 + 6);
      gl.bindTexture(gl.TEXTURE_2D, this.contextImage);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        columns,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      reconstruct ? this.contextImage : null,
      0,
    );
    gl.drawBuffers(
      reconstruct ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0],
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Incomplete continuous density framebuffer");
    gl.viewport(0, 0, columns, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (reconstruct) {
      this.reconstruction ??= new ContinuousWebGLReconstruction(gl);
      return this.reconstruction.render(
        this.image,
        this.contextImage,
        histogram,
        frame,
        pairGap(pair),
        columns,
        plan,
      );
    }
    const pixels = new Uint8ClampedArray(columns * height * 4);
    gl.readPixels(0, 0, columns, height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer));
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Continuous density WebGL error ${error}`);
    return { pixels, width: columns, height };
  }

  dispose(): void {
    this.reconstruction?.dispose();
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.gl.deleteTexture(this.image);
    this.gl.deleteTexture(this.contextImage);
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteProgram(this.program);
  }
}

interface CachedPairImage {
  histogram: ContinuousHistogram;
  signature: string;
  image: ContinuousPairImage;
  colors: LineColors;
}

export interface ContinuousDensityOptions {
  /** null explicitly selects the CPU reference. Omitted selects worker OffscreenCanvas GL. */
  gl?: WebGL2RenderingContext | null;
  software?: boolean;
}

/** Pair-local cache keys exclude screen position: a scroll only composites retained images. */
export class ContinuousDensityEvaluator {
  private gpu: ContinuousWebGLEvaluator | null;
  private software: boolean;
  private readonly cache = new Map<string, CachedPairImage>();

  constructor(options: ContinuousDensityOptions = {}) {
    const gl =
      options.gl === undefined
        ? typeof OffscreenCanvas === "undefined"
          ? null
          : new OffscreenCanvas(1, 1).getContext("webgl2", { antialias: false })
        : options.gl;
    this.gpu = gl === null ? null : new ContinuousWebGLEvaluator(gl);
    this.software = options.software ?? this.gpu?.software ?? true;
  }

  private switchToCPU(): void {
    this.gpu?.dispose();
    this.gpu = null;
    this.software = true;
    this.cache.clear();
  }

  private evaluatePair(
    pair: ContinuousPair,
    frame: ContinuousRequest,
    update: ContinuousUpdate,
    columns: number,
    plan: ContinuousReconstructionPlan | null,
  ): ContinuousPairImage {
    return this.gpu === null
      ? evaluateContinuousPairCPU(pair, frame, update, columns, plan !== null)
      : this.gpu.evaluate(pair, frame, update, columns, plan !== null, plan ?? undefined);
  }

  render(frame: ContinuousRequest, update: ContinuousUpdate): ContinuousImage {
    if (this.gpu?.contextLost) this.switchToCPU();
    try {
      const job = this.renderFrame(frame, update);
      for (;;) {
        const next = job.next();
        if (next.done) return next.value;
      }
    } catch (error) {
      if (!this.gpu?.contextLost) throw error;
      this.switchToCPU();
      return this.render(frame, update);
    }
  }

  async renderCooperative(
    frame: ContinuousRequest,
    update: ContinuousUpdate,
    isCurrent: () => boolean,
  ): Promise<ContinuousImage | null> {
    if (this.gpu?.contextLost) this.switchToCPU();
    try {
      const job = this.renderFrame(frame, update);
      while (isCurrent()) {
        const next = job.next();
        if (next.done) return next.value;
        // A task boundary admits worker messages; microtasks cannot deliver a new gesture.
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      }
      return null;
    } catch (error) {
      if (!this.gpu?.contextLost) throw error;
      this.switchToCPU();
      return this.renderCooperative(frame, update, isCurrent);
    }
  }

  private *renderFrame(
    frame: ContinuousRequest,
    update: ContinuousUpdate,
  ): Generator<void, ContinuousImage> {
    const started = performance.now();
    const width = Math.max(1, Math.ceil(frame.width));
    const height = Math.max(1, Math.ceil(frame.height));
    const pixels = new Uint8ClampedArray(width * height * 4);
    const active = new Set<string>();
    let evaluatedPairs = 0;
    let evaluatedColumns = 0;
    // Evaluate even offscreen pairs so later scroll frames cannot trigger histogram evaluation.
    for (const pair of update.pairs) {
      active.add(pair.key);
      const gap = pairGap(pair);
      if (gap <= 0) continue;
      const dense = pair.histogram.occupied.length > SPARSE_DENSITY_CELLS;
      const fraction =
        this.software && frame.draft && dense && pair.marginal === undefined ? 1 / 16 : 1;
      let columns = pair.marginal === undefined ? Math.max(1, Math.ceil(gap * fraction)) : 1;
      const signature = JSON.stringify([
        pair.histogram.revision,
        pair.marginal?.revision,
        pair.histogram.bins,
        gap,
        frame.height,
        columns,
        frame.lineWidth,
        pair.marginal === undefined && frame.curved,
        frame.colorMode,
        frame.contextColor,
        frame.contextAlpha,
        densityReference(update.selectedCount, frame.height),
        densityReference(update.contextCount, frame.height),
      ]);
      let cached = this.cache.get(pair.key);
      if (
        cached === undefined ||
        cached.histogram !== pair.histogram ||
        cached.signature !== signature ||
        cached.colors.palette !== update.colors.palette ||
        cached.colors.colorMapBins !== update.colors.colorMapBins
      ) {
        let plan =
          fraction < 1 ? continuousReconstructionPlan(pair.histogram, frame, gap, columns) : null;
        if (
          plan !== null &&
          continuousReconstructionNeedsRefinement(pair.histogram, frame, gap, columns, plan)
        ) {
          columns = Math.max(1, Math.ceil(gap));
          plan = null;
        }
        const evaluated = this.evaluatePair(pair, frame, update, columns, plan);
        const image =
          plan !== null
            ? reconstructContinuousPair(evaluated, pair.histogram, frame, gap, plan)
            : evaluated;
        cached = { histogram: pair.histogram, signature, image, colors: update.colors };
        this.cache.set(pair.key, cached);
        evaluatedPairs++;
        evaluatedColumns += columns;
      }
      compositePairImage(pixels, width, height, cached.image, pair.left.x, gap);
      yield;
    }
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    const rasterMs = performance.now() - started;
    return {
      pixels,
      width,
      height,
      milliseconds: update.countMs + rasterMs,
      countMs: update.countMs,
      rasterMs,
      rows: update.rows,
      axisBins: update.axisBins,
      evaluatedColumns,
      evaluatedPairs,
    };
  }

  dispose(): void {
    this.cache.clear();
    this.gpu?.dispose();
  }
}

/** Interpolation stays inside each pair and is performed in premultiplied color space. */
function compositePairImage(
  destination: Uint8ClampedArray,
  width: number,
  height: number,
  image: ContinuousPairImage,
  origin: number,
  gap: number,
): void {
  const start = Math.max(0, Math.ceil(origin - 0.5));
  const end = Math.min(width, Math.ceil(origin + gap - 0.5));
  for (let y = 0; y < height; ++y) {
    for (let x = start; x < end; ++x) {
      const source = Math.max(
        0,
        Math.min(image.width - 1, ((x + 0.5 - origin) / gap) * image.width - 0.5),
      );
      const below = Math.floor(source);
      const above = Math.min(below + 1, image.width - 1);
      const fraction = source - below;
      const left = (y * image.width + below) * 4;
      const right = (y * image.width + above) * 4;
      const alpha = image.pixels[left + 3] * (1 - fraction) + image.pixels[right + 3] * fraction;
      const offset = (y * width + x) * 4;
      if (alpha <= 0) continue;
      for (let channel = 0; channel < 3; ++channel) {
        destination[offset + channel] =
          (image.pixels[left + channel] * image.pixels[left + 3] * (1 - fraction) +
            image.pixels[right + channel] * image.pixels[right + 3] * fraction) /
          alpha;
      }
      destination[offset + 3] = alpha;
    }
  }
}
