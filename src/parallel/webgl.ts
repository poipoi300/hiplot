/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { ColorMode, RGB } from "../lib/colors";
import { linkProgram } from "../lib/webgl";
import { SPLINE_HANDLE } from "./spline";
import {
  BlockLayers,
  type BlockPartition,
  BlockPasses,
  BlockSelection,
  blockCountFor,
  blockLayerBytes,
  blocksFit,
  type HalfDraw,
  LAYER_CONTEXT,
  LAYER_SELECTED,
  LAYER_SKIPPED,
  PARTIAL_SLOTS,
  PartialSlots,
  partitionRows,
} from "./webgl_blocks";
import {
  encodePixelColumn,
  MISSING_THRESHOLD,
  padUint8,
  padUint32,
  pixelTextureCapacity,
  segmentsPerLine,
  type TextureLayout,
  textureLayout,
} from "./webgl_layout";

/** One axis as the renderer sees it: its x position and its pixel column. */
export interface RenderAxis {
  x: number;
  pixels: Float32Array;
}

export interface LineFrame {
  axes: ReadonlyArray<RenderAxis>;
  /** CSS pixel size of the plot area; the canvas holds it at device resolution. */
  width: number;
  height: number;
  /** Line width in CSS pixels. */
  lineWidth: number;
  /** Device pixels per CSS pixel the canvas was sized for. */
  pixelRatio: number;
  /** Monotone splines through the axes, or straight segments. */
  curved: boolean;
  /**
   * A frame of a brush or axis drag over many rows (see ParallelPlot), drawn
   * to fit the frame budget: one-pixel lines instead of anti-aliased strips,
   * with half the fragments. Density sums retain single-float precision.
   */
  draft: boolean;
  /**
   * A frame of a scroll or gesture, shown only until the next: it may move the
   * previous frame's density instead of drawing every row (see drawShifted),
   * and the frame after the motion settles draws every row.
   */
  transient: boolean;
  /**
   * Device resolution the densities are summed at, per axis, from 0 to 1:
   * below 1 in low-performance mode (see performance.ts), which then
   * stretches them over the canvas. Lines without float targets ignore it.
   */
  resolution: number;
  /** Rows drawn, from the start of the shuffled draw order: all of them, or a sample. */
  drawnRows: number;
  /** Selected and deselected line counts, which set the density scale. */
  selectedCount: number;
  contextCount: number;
  /** Color and peak opacity of the deselected lines. */
  contextColor: RGB;
  contextAlpha: number;
  /**
   * What a pixel crossed by several selected lines shows, for a numeric
   * color-by column; categorical columns mix their colors. Without float
   * render targets lines are alpha-blended in draw order instead, which the
   * caller sorts to put the lowest or highest values on top.
   */
  colorMode: ColorMode;
}

/**
 * The axis a brush gesture changes: frames sum retained blocks of its rows
 * instead of drawing every row (see webgl_blocks.ts).
 */
export interface LineFocus {
  /** Index of the brushed axis in the frame's axes. */
  axis: number;
  /**
   * Per row, 1 when it passes the brushes of every other axis. The blocks are
   * drawn for this array: a new one, even with equal flags, draws them again.
   * Frames are exact whatever the flags; flags that do not match the brushes
   * only leave more rows to draw one by one.
   */
  rows: Uint8Array;
  /** While the gesture runs, missing blocks are drawn; afterwards only matching ones are used. */
  active: boolean;
}

/** Blocks of a focus's rows, and what their layers were drawn from (see `matchingBlocks`). */
interface RetainedBlocks {
  layers: BlockLayers;
  partition: BlockPartition;
  /** Per layer, how the latest frame took it: the blocks, then two per partial slot. */
  states: Uint8Array;
  /** The first slot layer, after the blocks. */
  slotLayer: number;
  selection: BlockSelection;
  slots: PartialSlots;
  /** `partition.order`, as the line pass reads it. */
  order: WebGLTexture;
  /** The rows of the slots a frame draws, selected then deselected, and the texture the line pass reads them from. */
  slotRows: Uint32Array;
  slotOrder: WebGLTexture;
  focusRows: Uint8Array;
  focusAxis: number;
  rowsOrder: Uint32Array | null;
  bins: Uint32Array | null;
  palette: ReadonlyArray<RGB> | null;
  colorMapBins: number;
  style: string;
  axes: ReadonlyArray<RenderAxis>;
}

/**
 * A frame's canvas size in device pixels, which its owner gives the canvas
 * (see WebGLLineRenderer.create): what every offscreen target is sized from.
 */
export function deviceSize(frame: Pick<LineFrame, "width" | "height" | "pixelRatio">): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(1, Math.round(frame.width * frame.pixelRatio)),
    height: Math.max(1, Math.round(frame.height * frame.pixelRatio)),
  };
}

/** Everything but the axes, rows, colors and selection that a frame's density depends on. */
function densityStyle(frame: LineFrame): string {
  return JSON.stringify([blockStyle(frame), frame.draft, frame.drawnRows]);
}

/** Everything but the axes, rows and colors that the pixels of a block layer depend on. */
function blockStyle(frame: LineFrame): string {
  return JSON.stringify([
    frame.width,
    frame.height,
    frame.lineWidth,
    frame.pixelRatio,
    frame.curved,
    frame.resolution,
    frame.colorMode,
  ]);
}

/** Consecutive segments of every line: `count` from segment `first` (see segmentsPerLine). */
interface SegmentRun {
  first: number;
  count: number;
}

/** What the density targets hold: the sums of a frame drawn with these inputs. */
interface DensityContent {
  targets: DensityTargets;
  style: string;
  axes: ReadonlyArray<RenderAxis>;
  rowsOrder: Uint32Array | null;
  drawOrder: Uint32Array | null;
  bins: Uint32Array | null;
  palette: ReadonlyArray<RGB> | null;
  colorMapBins: number;
  selectionRevision: number;
}

/** Horizontal reach of a stub from its axis, in CSS pixels: the first and last axes, and missing values. */
const STUB_PIXELS = 15;

/** Half a line's drawn width in device pixels: drafts draw one-pixel lines. */
function lineHalfWidth(frame: LineFrame): number {
  return frame.draft ? 0.5 : (frame.lineWidth * frame.pixelRatio) / 2;
}

/**
 * The run of segments whose lines can cover target columns `[from, to)` of a
 * frame, `scale` target pixels per CSS pixel: a segment spans its two axes,
 * stubs reach STUB_PIXELS past an axis, and strip corners stretch by up to
 * MITER_LIMIT half widths. Segments between the run's ends are included too,
 * so the run draws in the order a full frame does.
 */
export function segmentsCovering(
  axes: ReadonlyArray<{ x: number }>,
  scale: number,
  margin: number,
  from: number,
  to: number,
): SegmentRun | null {
  let first = -1;
  let last = -1;
  for (let segment = 0; segment <= axes.length; ++segment) {
    // A segment runs between its axes; a stub leaves the left one rightward, enters the right one.
    const left = segment > 0 ? axes[segment - 1].x : Number.NaN;
    const right = segment < axes.length ? axes[segment].x : Number.NaN;
    const ends = [left, left + STUB_PIXELS, right - STUB_PIXELS, right].filter(
      (x) => !Number.isNaN(x),
    );
    const low = Math.min(...ends);
    const high = Math.max(...ends);
    if (low * scale - margin < to && high * scale + margin > from) {
      if (first === -1) first = segment;
      last = segment;
    }
  }
  return first === -1 ? null : { first, count: last - first + 1 };
}

/**
 * Rows per batch of one kind of cooperative line draw, in rows of every
 * segment (see drawRows), adapted toward 6 ms of GPU time per batch. Kinds
 * whose rows cost differently keep their own: a scrolled strip is scissored to
 * a few columns, so its rows skip most fragment work, and a size learned on
 * strips would make the next full frame's first batches far too long.
 */
export class BatchSize {
  constructor(public rows: number) {}

  /**
   * From a finished batch of this size that took `milliseconds` of GPU time:
   * toward 6 ms, at most twofold per batch, within 1 and 32768 rows. A short
   * batch (the last of a range) only shrinks the size, and only when it
   * overran: otherwise its few rows say little of the GPU's rate.
   */
  adapt({ rows, drawn, full }: LineBatch, milliseconds: number): void {
    const elapsed = Math.max(1, milliseconds);
    if (!full) {
      if (elapsed > 6)
        this.rows = Math.max(1, Math.min(this.rows, Math.floor((drawn * 6) / elapsed)));
      return;
    }
    this.rows = Math.max(1, Math.min(32768, Math.floor(rows * Math.min(2, 6 / elapsed))));
  }
}

/**
 * One submitted batch of a cooperative draw (see cooperate): rows of lines in
 * batches of `size`, or, without one, other work such as a scroll's copy pass.
 */
export interface LineBatch {
  size: BatchSize | null;
  /** The size's rows when the batch was drawn. */
  rows: number;
  /** Rows of every segment it drew (see drawRows). */
  drawn: number;
  /** Drew all of `rows`, decided on whole instance counts: the end of a range may draw fewer. */
  full: boolean;
}

/** A frame the GPU finished drawing. */
export interface FinishedFrame {
  milliseconds: number;
  /** Neither a draft nor reduced in resolution. */
  fullQuality: boolean;
  /** Summed from a brush gesture's retained blocks (see LineFocus). */
  fromBlocks: boolean;
  /**
   * Drew every row. Frames summed from retained blocks, or moved from the
   * previous frame's density, show the same picture faster: their time says
   * nothing of how slowly this machine draws full frames.
   */
  drewEveryRow: boolean;
}

/** How rows are colored: a palette color per row, by bin. */
/** Whether `canvas` is in the page's document, not an offscreen canvas; workers have no HTMLCanvasElement. */
function isPageCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement;
}

export interface LineColors {
  bins: Uint32Array;
  palette: ReadonlyArray<RGB>;
  /**
   * For a numeric color-by column, the leading palette entries, which sample
   * its color map evenly from 0 to 1; the one entry after them is the color
   * of missing values. 0 for a categorical column, whose palette has a color
   * per category.
   */
  colorMapBins: number;
}

/**
 * Points sampled along one curved segment: about one per `CURVE_SAMPLE_PIXELS`
 * of the widest gap between axes, within bounds. Each point is two vertices of
 * the triangle strip that covers the segment.
 */
const CURVE_SAMPLE_PIXELS = 6;
const MIN_CURVE_SAMPLES = 8;
const MAX_CURVE_SAMPLES = 40;

/** Points sampled along every segment of a frame's lines. */
export function segmentSamples(axes: ReadonlyArray<{ x: number }>, curved: boolean): number {
  if (!curved) {
    return 2;
  }
  let widestGap = 0;
  for (let i = 1; i < axes.length; ++i) {
    widestGap = Math.max(widestGap, Math.abs(axes[i].x - axes[i - 1].x));
  }
  return Math.max(
    MIN_CURVE_SAMPLES,
    Math.min(MAX_CURVE_SAMPLES, Math.ceil(widestGap / CURVE_SAMPLE_PIXELS) + 1),
  );
}

/** Which lines a draw call keeps. */
const DRAW_SELECTED = 0;
const DRAW_CONTEXT = 1;
const DRAW_ALL = 2;

/**
 * Longest a strip corner may stretch, in half widths, where a line turns
 * sharply; beyond it the corner is cut, as a canvas `miterLimit` does.
 */
const MITER_LIMIT = 4;

/**
 * One instance per segment of a line. A segment is a triangle strip through
 * `u_samples` points along it, widened on both sides by half the line's
 * footprint (see COVERAGE) plus the half extent of a device pixel across
 * the line, where coverage reaches zero; `v_across` is the signed distance
 * from the center line in device pixels and `v_footprint` the pixel's
 * extents across it, from which fragments take their coverage.
 *
 * The strip is a polyline of chords between the sampled points, so each
 * point is pushed out along the miter of its two chords: every chord then
 * has the full width perpendicular to itself, which `v_across` assumes. At
 * the ends of a segment the neighbor chord comes from the adjacent segment,
 * so segments join without seams. (Offsetting along the curve's tangent
 * instead pinches a chord that is steeper than the tangent at its end, as
 * on straight segments, whose tangents at the axes are level: steep lines
 * then rasterize as broken one-pixel dots.)
 */
const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform sampler2D u_pixels;
uniform sampler2D u_axes;
uniform usampler2D u_order;
uniform usampler2D u_selected;
uniform usampler2D u_bins;
uniform sampler2D u_palette;
uniform int u_axisCount;
uniform int u_rowOffset;
uniform int u_textureWidth;
uniform int u_rowsPerColumn;
uniform int u_colorMapBins;
uniform int u_samples;
uniform int u_keep;
uniform int u_segmentFirst;
uniform int u_segmentCount;
/** Draws every row as selected: a block layer of the brushed-axis cache (see webgl_blocks.ts). */
uniform bool u_allSelected;
uniform bool u_curved;
uniform bool u_antialiased;
uniform vec2 u_deviceScale;
uniform vec2 u_viewport;
uniform float u_halfWidth;

out vec3 v_rgb;
/** The row's position on a numeric color map, or -1 (categorical column, missing value). */
flat out float v_value;
out float v_selected;
out float v_across;
out vec2 v_footprint;

ivec2 at(int index) {
  return ivec2(index % u_textureWidth, index / u_textureWidth);
}

vec4 axis(int index) {
  return texelFetch(u_axes, ivec2(index, 0), 0);
}

float pixelY(int axisIndex, int row) {
  int slot = int(axis(axisIndex).y);
  ivec2 texel = ivec2(row % u_textureWidth, slot * u_rowsPerColumn + row / u_textureWidth);
  return texelFetch(u_pixels, texel, 0).r;
}

/** Steffen's monotone slope at axis i, where the row is at height y (see spline.ts). */
float slopeAt(int i, int row, float y) {
  if (i <= 0 || i >= u_axisCount - 1) {
    return 0.0;
  }
  float yBefore = pixelY(i - 1, row);
  float yAfter = pixelY(i + 1, row);
  if (yBefore < ${MISSING_THRESHOLD} || yAfter < ${MISSING_THRESHOLD}) {
    return 0.0;
  }
  float before = axis(i).x - axis(i - 1).x;
  float after = axis(i + 1).x - axis(i).x;
  if (!(before > 0.0 && after > 0.0)) {
    return 0.0;
  }
  float slopeBefore = (y - yBefore) / before;
  float slopeAfter = (yAfter - y) / after;
  float parabola = (slopeBefore * after + slopeAfter * before) / (before + after);
  return (sign(slopeBefore) + sign(slopeAfter)) *
    min(min(abs(slopeBefore), abs(slopeAfter)), 0.5 * abs(parabola));
}

/** One segment of a row's line: a cubic Bezier between two axes, or a stub. */
struct Segment {
  bool drawn;
  bool hasLeft;
  bool hasRight;
  vec2 p0;
  vec2 p1;
  vec2 p2;
  vec2 p3;
};

Segment segmentOf(int segment, int row) {
  Segment s;
  float yLeft = segment >= 1 ? pixelY(segment - 1, row) : ${MISSING_THRESHOLD * 10};
  float yRight = segment < u_axisCount ? pixelY(segment, row) : ${MISSING_THRESHOLD * 10};
  s.hasLeft = yLeft > ${MISSING_THRESHOLD};
  s.hasRight = yRight > ${MISSING_THRESHOLD};
  s.drawn = s.hasLeft || s.hasRight;
  float xLeft = 0.0;
  float xRight = 0.0;
  float slopeLeft = 0.0;
  float slopeRight = 0.0;
  if (s.hasLeft && s.hasRight) {
    xLeft = axis(segment - 1).x;
    xRight = axis(segment).x;
    if (u_curved) {
      slopeLeft = slopeAt(segment - 1, row, yLeft);
      slopeRight = slopeAt(segment, row, yRight);
    }
  } else if (s.hasRight) {
    // Stub leading into the first axis, or into an axis after a missing value.
    xRight = axis(segment).x;
    xLeft = xRight - ${STUB_PIXELS.toFixed(1)};
    yLeft = yRight;
  } else if (s.hasLeft) {
    // Stub leaving the last axis, or an axis before a missing value.
    xLeft = axis(segment - 1).x;
    xRight = xLeft + ${STUB_PIXELS.toFixed(1)};
    yRight = yLeft;
  }
  float handle = ${SPLINE_HANDLE.toFixed(6)} * (xRight - xLeft);
  s.p0 = vec2(xLeft, yLeft);
  s.p1 = vec2(xLeft + handle, yLeft + handle * slopeLeft);
  s.p2 = vec2(xRight - handle, yRight - handle * slopeRight);
  s.p3 = vec2(xRight, yRight);
  return s;
}

/** A point of the segment, in device pixels. */
vec2 pointOf(Segment s, float t) {
  float u = 1.0 - t;
  vec2 position = u * u * u * s.p0 + 3.0 * u * u * t * s.p1 + 3.0 * u * t * t * s.p2 +
    t * t * t * s.p3;
  return position * u_deviceScale;
}

/** The left-hand unit normal of the chord from \`from\` to \`to\`. */
vec2 chordNormal(vec2 from, vec2 to) {
  vec2 chord = to - from;
  float length2 = dot(chord, chord);
  vec2 direction = length2 > 1e-12 ? chord * inversesqrt(length2) : vec2(1.0, 0.0);
  return vec2(-direction.y, direction.x);
}

/**
 * Straight lines only: the far end of the segment that joins this one at axis
 * \`joint\`, toward axis \`far\` (the next point, or the end of a stub where
 * the row has no value), in device pixels. One texel fetch where the
 * general \`segmentOf\` takes two.
 */
vec2 straightNeighbor(int joint, int far, int row, float jointY, float direction) {
  if (far >= 0 && far < u_axisCount) {
    float y = pixelY(far, row);
    if (y > ${MISSING_THRESHOLD}) {
      return vec2(axis(far).x, y) * u_deviceScale;
    }
  }
  return vec2(axis(joint).x + direction * ${STUB_PIXELS.toFixed(1)}, jointY) * u_deviceScale;
}

void main() {
  // Instances run line by line over the segments [u_segmentFirst, + u_segmentCount).
  int line = gl_InstanceID / u_segmentCount;
  int segment = u_segmentFirst + gl_InstanceID - line * u_segmentCount;
  int row = int(texelFetch(u_order, at(line + u_rowOffset), 0).r);
  bool selected = u_allSelected || texelFetch(u_selected, at(row), 0).r > 0u;
  bool kept = u_keep == ${DRAW_ALL} || (u_keep == ${DRAW_SELECTED}) == selected;

  Segment current = segmentOf(segment, row);
  if (!kept || !current.drawn) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_rgb = vec3(0.0);
    v_value = -1.0;
    v_selected = 0.0;
    v_across = 0.0;
    v_footprint = vec2(1.0, 0.0);
    return;
  }

  // Strips take two vertices per point, one on each side; plain lines one.
  int point = u_antialiased ? gl_VertexID / 2 : gl_VertexID;
  float side = !u_antialiased ? 0.0 : (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  float step = 1.0 / float(u_samples - 1);
  float t = float(point) * step;
  vec2 position = pointOf(current, t);
  // Plain lines cover their pixels fully: a pixel is one pixel wide across a level line.
  vec2 footprint = vec2(1.0, 0.0);
  float extent = 0.0;
  if (u_antialiased) {
    // The chords into and out of this point; at a segment's end, from the
    // segment it joins (an axis the row has a value on).
    bool hasBefore = point > 0 || (current.hasLeft && segment > 0);
    bool hasAfter = point < u_samples - 1 || (current.hasRight && segment < u_axisCount);
    vec2 before = position;
    vec2 after = position;
    if (point > 0) {
      before = pointOf(current, t - step);
    } else if (hasBefore) {
      before = u_curved
        ? pointOf(segmentOf(segment - 1, row), 1.0 - step)
        : straightNeighbor(segment - 1, segment - 2, row, current.p0.y, -1.0);
    }
    if (point < u_samples - 1) {
      after = pointOf(current, t + step);
    } else if (hasAfter) {
      after = u_curved
        ? pointOf(segmentOf(segment + 1, row), step)
        : straightNeighbor(segment, segment + 1, row, current.p3.y, 1.0);
    }
    vec2 normalIn = chordNormal(before, position);
    vec2 normalOut = chordNormal(position, after);
    // A pixel spans |n.x| + |n.y| across a line of unit normal n, here the
    // chord of this segment the point starts (or, at its end, finishes).
    footprint = abs(point < u_samples - 1 ? normalOut : normalIn);
    extent = max(u_halfWidth, 0.5) + 0.5 * (footprint.x + footprint.y);
    vec2 offset = hasBefore ? normalIn : normalOut;
    if (hasBefore && hasAfter) {
      vec2 miter = normalIn + normalOut;
      float miterLength2 = dot(miter, miter);
      vec2 direction = miterLength2 > 1e-6 ? miter * inversesqrt(miterLength2) : normalIn;
      offset = direction / max(dot(direction, normalIn), ${(1 / MITER_LIMIT).toFixed(6)});
    }
    position += offset * side * extent;
  }
  gl_Position = vec4(
    position.x / u_viewport.x * 2.0 - 1.0,
    1.0 - position.y / u_viewport.y * 2.0,
    0.0,
    1.0
  );
  uint bin = texelFetch(u_bins, at(row), 0).r;
  v_rgb = texelFetch(u_palette, at(int(bin)), 0).rgb;
  v_value = int(bin) < u_colorMapBins ? float(bin) / float(u_colorMapBins - 1) : -1.0;
  v_selected = selected ? 1.0 : 0.0;
  v_across = side * extent;
  v_footprint = footprint;
}
`;

/**
 * Coverage of a device pixel `v_across` from the center of a line
 * `2 * u_halfWidth` wide: the exact fraction of the pixel's square inside
 * the line, a box filter. Across a line of unit normal n, the square's area
 * spreads as the sum of two uniform spans |n.x| and |n.y| wide, a
 * trapezoid; the coverage is its share within the line's half width of the
 * pixel center. Summed over a column of pixels, it is the line's area in
 * that column, so a line's intensity per unit length is the same wherever
 * it falls between pixel centers. A line narrower than a pixel keeps a
 * one-pixel footprint and fades with its width, as Canvas 2D hairlines do.
 *
 * A one-pixel footprint never covers a whole pixel unless it is level: at
 * most 91% at 45 degrees. Coverage is scaled up by the share the line
 * covers of a pixel on its center, so a pixel a line runs through the
 * middle of counts as covered, and pixels crossed by many lines at all
 * offsets, whose peak coverage stands for how much of them is covered (see
 * COMPOSITE_FRAGMENT_SHADER), reach full opacity. Lines at 45 degrees are
 * then up to 9% brighter than level ones, the same all along each line.
 */
const COVERAGE = `
uniform float u_halfWidth;
in float v_across;
in vec2 v_footprint;
/** Share of the pixel's square within \`x\` across the line of its center. */
float squareBelow(float x, float narrow, float wide) {
  float outer = 0.5 * (narrow + wide);
  float inner = 0.5 * (wide - narrow);
  if (x <= -outer) {
    return 0.0;
  }
  if (x >= outer) {
    return 1.0;
  }
  if (x < -inner) {
    return (x + outer) * (x + outer) / (2.0 * narrow * wide);
  }
  if (x <= inner) {
    return 0.5 + x / wide;
  }
  return 1.0 - (outer - x) * (outer - x) / (2.0 * narrow * wide);
}
float coverage() {
  float halfFootprint = max(u_halfWidth, 0.5);
  vec2 spans = normalize(v_footprint);
  float narrow = min(spans.x, spans.y);
  float wide = max(spans.x, spans.y);
  float inside = squareBelow(v_across + halfFootprint, narrow, wide) -
    squareBelow(v_across - halfFootprint, narrow, wide);
  float insideOnCenter = squareBelow(halfFootprint, narrow, wide) -
    squareBelow(-halfFootprint, narrow, wide);
  return inside / insideOnCenter * min(2.0 * u_halfWidth, 1.0);
}
`;

/** `u_colorMode` of the density passes, one per ColorMode. */
const COLOR_MODE_CODES: Record<ColorMode, number> = { mean: 0, lowest: 1, highest: 2 };

/**
 * The line that a pixel shows on top in the "lowest" and "highest" color
 * modes, kept by MAX blending as one float: 1 + rank * levels + coverage,
 * the rank being the color map bin counted toward the end on top (0 to 255)
 * and the coverage quantized to `levels` steps, the most that keeps every
 * key an exact integer in a single float. The highest rank wins, then
 * the highest coverage; 0 means no line.
 */
const ON_TOP_COVERAGE_LEVELS = 1024;

/**
 * Accumulates line density into three targets (see `draw`), which add up
 * their color channels and keep the maximum of their alpha channels.
 * Target 0 adds up, per selected line, its coverage-weighted color and keeps
 * the selected peak coverage. The color is the line's palette color for a
 * categorical column; for a numeric one, its value on the color map (r),
 * its coverage if its value is missing (g) and its coverage (b). Target 1
 * adds up the selected (r) and deselected (g) coverages and keeps the
 * deselected peak; target 2, drawn in the "lowest" and "highest" modes
 * only, keeps the line on top (see ON_TOP_COVERAGE_LEVELS).
 */
const DENSITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${COVERAGE}
uniform bool u_valueColors;
uniform int u_colorMode;
uniform float u_onTopLevels;
in vec3 v_rgb;
flat in float v_value;
in float v_selected;
layout(location = 0) out vec4 selectedSums;
layout(location = 1) out vec4 coverageSums;
layout(location = 2) out vec4 onTop;
void main() {
  float covered = coverage();
  float selectedCoverage = v_selected * covered;
  float contextCoverage = (1.0 - v_selected) * covered;
  bool valued = v_value >= 0.0;
  selectedSums = !u_valueColors
    ? vec4(v_rgb * selectedCoverage, selectedCoverage)
    : vec4(valued ? v_value * selectedCoverage : 0.0, valued ? 0.0 : selectedCoverage,
        selectedCoverage, selectedCoverage);
  coverageSums = vec4(selectedCoverage, contextCoverage, 0.0, contextCoverage);
  float key = 0.0;
  if (u_colorMode != ${COLOR_MODE_CODES.mean} && valued && selectedCoverage > 0.0) {
    float rank = u_colorMode == ${COLOR_MODE_CODES.highest} ? v_value : 1.0 - v_value;
    key = 1.0 + round(rank * 255.0) * u_onTopLevels + round(selectedCoverage * (u_onTopLevels - 1.0));
  }
  onTop = vec4(0.0, 0.0, 0.0, key);
}
`;

/** Without float render targets: plain alpha blending, deselected lines first. */
const DIRECT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${COVERAGE}
uniform float u_alpha;
uniform vec3 u_contextColor;
uniform float u_contextAlpha;
in vec3 v_rgb;
in float v_selected;
out vec4 color;
void main() {
  vec4 opaque = v_selected > 0.5
    ? vec4(v_rgb * u_alpha, u_alpha)
    : vec4(u_contextColor * u_contextAlpha, u_contextAlpha);
  color = opaque * coverage();
}
`;

const IMAGE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_viewport;
out vec4 color;
vec4 premultipliedAt(ivec2 pixel, ivec2 size) {
  vec4 image = texelFetch(u_image, clamp(pixel, ivec2(0), size - 1), 0);
  return vec4(image.rgb * image.a, image.a);
}
void main() {
  vec2 at = gl_FragCoord.xy / u_viewport;
  vec2 uv = vec2(at.x, 1.0 - at.y);
  ivec2 size = textureSize(u_image, 0);
  if (!any(greaterThan(u_viewport, vec2(size)))) {
    vec4 image = texture(u_image, uv);
    color = vec4(image.rgb * image.a, image.a);
    return;
  }
  // Interpolate coverage-weighted colors, not hidden RGB in transparent texels.
  vec2 position = uv * vec2(size) - 0.5;
  ivec2 below = ivec2(floor(position));
  vec2 fraction = fract(position);
  color = mix(
    mix(premultipliedAt(below, size), premultipliedAt(below + ivec2(1, 0), size), fraction.x),
    mix(premultipliedAt(below + ivec2(0, 1), size),
      premultipliedAt(below + ivec2(1, 1), size), fraction.x),
    fraction.y
  );
}
`;

const COMPOSITE_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Log tone mapping of the accumulated densities: opacity grows with the log of
 * how many lines cross a pixel, relative to a reference density. The color is
 * the average color of those lines for a categorical column; for a numeric
 * one, the color map at their average value, mixed with the missing-value
 * color by the share of lines without a value, or, in the "lowest" and
 * "highest" modes, the color of the line on top over that, as far as it
 * covers the pixel. Mixing values rather than colors keeps every color on the
 * color map: averaging the colors of distant values gives muddy colors that
 * the map does not have. The selection is composited over the faint
 * deselected layer.
 *
 * Coverage is applied after the tone mapping, not inside it. N lines that
 * coincide and cover a fraction c of a pixel are a line of density N drawn
 * with coverage c. Tone-mapped as one density N * c, they saturate as soon
 * as c exceeds a few lines' worth of the reference, which turns the
 * anti-aliased edge of every bundle of identical segments into a hard step.
 * The pixel's peak coverage stands for c: the density is the coverage sum
 * over that peak, and the opacity is the peak times its tone mapping. A lone
 * line or a bundle comes out exactly; where many lines cross a pixel at
 * different offsets the peak nears 1 and the density is the plain sum.
 *
 * The canvas holds 8 bits per channel. Where many lines fan out, opacity and
 * color fade by about one level every few pixels, and rounding each pixel
 * holds every level over a band; half a level of noise that differs between
 * neighbors (interleaved gradient noise, Jimenez 2014) makes them round
 * either way instead, which the eye averages back into the fade.
 */
const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_selectedSums;
uniform sampler2D u_coverageSums;
uniform sampler2D u_onTop;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
uniform bool u_valueColors;
uniform int u_colorMapBins;
uniform int u_colorMode;
uniform float u_onTopLevels;
uniform float u_selectedReference;
uniform float u_contextReference;
uniform vec3 u_contextColor;
uniform float u_contextAlpha;
/** Resolution of the density targets relative to the canvas (see LineFrame.resolution). */
uniform float u_resolution;
out vec4 color;
/** A threshold in [0, 1) per pixel, unlike its neighbors'. */
float gradientNoise(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}
float toneMapped(float coverageSum, float peakCoverage, float reference) {
  if (peakCoverage <= 0.0) {
    return 0.0;
  }
  float density = coverageSum / peakCoverage;
  return peakCoverage * clamp(log(1.0 + density) / log(1.0 + reference), 0.0, 1.0);
}
vec3 paletteColor(int bin) {
  return texelFetch(u_palette, ivec2(bin % u_paletteWidth, bin / u_paletteWidth), 0).rgb;
}
/** The color map at \`value\` in [0, 1], interpolated between its bins. */
vec3 colorMapAt(float value) {
  float position = clamp(value, 0.0, 1.0) * float(u_colorMapBins - 1);
  int below = int(floor(position));
  int above = min(below + 1, u_colorMapBins - 1);
  return mix(paletteColor(below), paletteColor(above), position - float(below));
}
/** The color of the selected lines crossing \`pixel\` (see DENSITY_FRAGMENT_SHADER). */
vec3 selectedColor(ivec2 pixel, vec4 sums, float selectedCoverage) {
  if (!u_valueColors) {
    return sums.rgb / selectedCoverage;
  }
  // Summed in the same target as the values, at the same precision.
  float valuedCoverage = sums.b - sums.g;
  vec3 mixed = valuedCoverage > 0.0 ? colorMapAt(sums.r / valuedCoverage) : vec3(0.0);
  mixed = mix(mixed, paletteColor(u_colorMapBins), sums.g / sums.b);
  float key = u_colorMode == ${COLOR_MODE_CODES.mean} ? 0.0 : texelFetch(u_onTop, pixel, 0).a;
  if (key <= 0.0) {
    return mixed;
  }
  float rank = floor((key - 1.0) / u_onTopLevels) / 255.0;
  float coverage = mod(key - 1.0, u_onTopLevels) / (u_onTopLevels - 1.0);
  float value = u_colorMode == ${COLOR_MODE_CODES.highest} ? rank : 1.0 - rank;
  return mix(mixed, colorMapAt(value), min(coverage / sums.a, 1.0));
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy * u_resolution);
  vec4 sums = texelFetch(u_selectedSums, pixel, 0);
  vec4 coverage = texelFetch(u_coverageSums, pixel, 0);
  float selectedAlpha = toneMapped(coverage.r, sums.a, u_selectedReference);
  float contextAlpha = u_contextAlpha * toneMapped(coverage.g, coverage.a, u_contextReference);
  vec3 selectedColor = coverage.r > 0.0 ? selectedColor(pixel, sums, coverage.r) : vec3(0.0);
  color = vec4(
    selectedColor * selectedAlpha + u_contextColor * contextAlpha * (1.0 - selectedAlpha),
    selectedAlpha + contextAlpha * (1.0 - selectedAlpha)
  );
  if (color.a <= 0.0) {
    return;
  }
  // Color and opacity take noise from two patterns: over a background the
  // shown color mixes both, and equal noise in both cancels over white.
  color.rgb += (gradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  color.a += (gradientNoise(gl_FragCoord.yx) - 0.5) / 255.0;
  color = clamp(color, 0.0, 1.0);
  color.rgb = min(color.rgb, color.a);
}
`;

/**
 * Copies the density targets moved `u_shift` columns right, zeros where the
 * move exposes columns: the start of a frame whose axes only moved together.
 */
const SHIFT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_selectedSums;
uniform sampler2D u_coverageSums;
uniform sampler2D u_onTop;
uniform int u_shift;
layout(location = 0) out vec4 selectedSums;
layout(location = 1) out vec4 coverageSums;
layout(location = 2) out vec4 onTop;
void main() {
  ivec2 source = ivec2(gl_FragCoord.xy) - ivec2(u_shift, 0);
  if (source.x < 0 || source.x >= textureSize(u_selectedSums, 0).x) {
    selectedSums = vec4(0.0);
    coverageSums = vec4(0.0);
    onTop = vec4(0.0);
    return;
  }
  selectedSums = texelFetch(u_selectedSums, source, 0);
  coverageSums = texelFetch(u_coverageSums, source, 0);
  onTop = texelFetch(u_onTop, source, 0);
}
`;

const LINE_SAMPLERS = {
  u_pixels: 0,
  u_axes: 1,
  u_order: 2,
  u_selected: 3,
  u_bins: 4,
  u_palette: 5,
} as const;
type SamplerName = keyof typeof LINE_SAMPLERS;
const UNITS = LINE_SAMPLERS;
/** Texture units of the density targets, read by the composite pass. */
const DENSITY_UNITS = { selectedSums: 6, coverageSums: 7, onTop: 8 } as const;

/**
 * Float formats of the density targets. A half float holds 11 significant
 * bits: summing thousands of coverages per pixel, as a bundle of identical
 * segments between two discrete axes does, its sum stops growing once its
 * spacing exceeds twice the added coverage, at a point that depends on that
 * coverage, so a sum of colors over a sum of coverages drifts from pixel to
 * pixel. Scaling contributions cannot repair this relative-precision limit.
 * All additive targets therefore use single floats, including draft frames.
 * The density path requires EXT_float_blend; without it the existing direct
 * alpha-blended path does not accumulate half-float densities.
 */
interface DensityPrecision {
  selectedSums: number;
  coverageSums: number;
  onTop: number;
}

/**
 * Lines crossing a pixel at which the density reaches full opacity. Densities
 * scale with the line count per pixel of plot height, so the reference does
 * too; a single line always stays visible.
 */
export function densityReference(lineCount: number, plotHeight: number): number {
  return Math.max(2, (12 * lineCount) / Math.max(1, plotHeight));
}

/**
 * Yields to later tasks, for polling GPU completion from a worker. Timers
 * nested this deeply wait at least 4 ms, longer than a whole brush frame's GPU
 * work; a message is delivered at once. One channel serves a whole wait, which
 * polls hundreds of times a frame: a channel per poll leaves enough native
 * garbage for collections that stall the worker by a frame. Software
 * rasterization shares CPU time with the polling worker, so it polls with
 * timers. Close the poller when the wait is over.
 */
export class TaskPoller {
  private channel: MessageChannel | null = null;
  private waiting: (() => void) | null = null;

  constructor(private readonly softwareRendering: boolean) {}

  next(): Promise<void> {
    if (this.waiting !== null) throw new Error("A task poller waits for one task at a time");
    return new Promise<void>((resolve) => {
      if (this.softwareRendering) {
        setTimeout(resolve, 0);
        return;
      }
      if (this.channel === null) {
        this.channel = new MessageChannel();
        this.channel.port1.onmessage = () => {
          const waiting = this.waiting;
          this.waiting = null;
          waiting?.();
        };
      }
      this.waiting = resolve;
      this.channel.port2.postMessage(null);
    });
  }

  close(): void {
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = null;
    this.waiting = null;
  }
}

/** A linked program and its uniform locations, looked up by name once. */
class Program {
  readonly program: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ) {
    this.program = linkProgram(gl, vertexSource, fragmentSource, "WebGL");
  }

  uniform(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.locations.get(name) ?? null;
  }
}

/** An 8-bit color target a frame without float targets draws into, then copies to its canvas. */
interface DirectTarget {
  framebuffer: WebGLFramebuffer;
  renderbuffer: WebGLRenderbuffer;
  width: number;
  height: number;
}

/** Float render targets the line pass accumulates densities into (see DENSITY_FRAGMENT_SHADER). */
interface DensityTargets {
  framebuffer: WebGLFramebuffer;
  selectedSums: WebGLTexture;
  coverageSums: WebGLTexture;
  onTop: WebGLTexture;
  precision: DensityPrecision;
  width: number;
  height: number;
}

/**
 * Draws parallel-coordinate lines with WebGL2 in one instanced draw call: one
 * instance per segment, positions read from textures. Row data (pixel columns,
 * draw order, colors) is uploaded once and kept on the GPU; a brush only
 * re-uploads the per-row selection flags, and reordering or dragging an axis
 * only the tiny axes texture.
 */
export class WebGLLineRenderer {
  private readonly gl: WebGL2RenderingContext;
  /** Unknown diagnostics use the software threshold rather than risk a minute-long first frame. */
  readonly softwareRendering: boolean;
  /** Density accumulation then tone mapping, when float render targets exist. */
  private readonly densityPrograms: { lines: Program; composite: Program } | null;
  /** Alpha-blended lines, the fallback without float render targets. */
  private readonly directProgram: Program;
  private density: DensityTargets | null = null;
  /** Targets of the same size a shifted frame copies the density into (see drawShifted). */
  private spareDensity: DensityTargets | null = null;
  /** What `density` holds, for frames that only shift or repeat it. */
  private densityContent: DensityContent | null = null;
  private shiftProgram: Program | null = null;
  /** Counts uploads of new selection flags, which change every density. */
  private selectionRevision = 0;
  /** The retained blocks of the latest brush gesture's axis, kept for the next gesture on it. */
  private blocks: RetainedBlocks | null = null;
  private blockPasses: BlockPasses | null = null;
  private imageProgram: Program | null = null;
  private imageTexture: WebGLTexture | null = null;
  /** Where a batched frame draws without float targets, then copied to the canvas (see drawFrame). */
  private directTargets: DirectTarget | null = null;
  private readonly textures: Record<SamplerName, WebGLTexture>;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly maxTextureSize: number;
  /** The largest canvas and target side this GPU renders (see surfaceSize). */
  private readonly maxSurfaceSize: number;
  private layout: TextureLayout = { width: 1, rowsPerColumn: 1 };
  private rowCount = 0;
  /** Texture slot of each uploaded pixel column. */
  private slots = new Map<Float32Array, number>();
  private slotCapacity = 0;
  /** The shuffled order of the current rows, which identifies them. */
  private rowsOrder: Uint32Array | null = null;
  private uploadedOrder: Uint32Array | null = null;
  private uploadedBins: Uint32Array | null = null;
  private uploadedPalette: ReadonlyArray<RGB> | null = null;
  private colorMapBins = 0;
  /** The selection texture's texels, kept to compare and upload without allocating per move. */
  private selectionTexels: Uint8Array | null = null;
  /** The uploaded per-row flags: a view of `selectionTexels` without the padding. */
  private uploadedSelection: Uint8Array | null = null;
  /** Signals when the GPU has finished the last frame drawn. */
  private inFlight: WebGLSync | null = null;
  /** When the frame in flight was submitted, and whether it was drawn at full quality. */
  private submittedAt = 0;
  private inFlightFullQuality = false;
  private inFlightFromBlocks = false;
  private inFlightDrewEveryRow = false;
  /** Batch sizes of cooperative line draws (see cooperate): every row's lines, and scrolled strips. */
  private readonly lineBatches = new BatchSize(128);
  private stripBatches: BatchSize | null = null;
  /** The last frame seen finished, until finishedFrame() reads it. */
  private finished: FinishedFrame | null = null;

  /**
   * A renderer on `canvas`, or null when WebGL2 is unavailable. With
   * `sizesCanvas`, the renderer sizes the canvas to each frame (see
   * bindCanvas); otherwise its owner sizes it to deviceSize.
   */
  static create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    sizesCanvas = false,
  ): WebGLLineRenderer | null {
    const options: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    };
    // Typed and called on each canvas type: on the union, or with inferred
    // options, the compiler can settle on getContext's untyped overload,
    // depending on the order it checks the program's files.
    const gl = isPageCanvas(canvas)
      ? canvas.getContext("webgl2", options)
      : canvas.getContext("webgl2", options);
    return gl === null ? null : new WebGLLineRenderer(gl, sizesCanvas ? canvas : null);
  }

  private constructor(
    gl: WebGL2RenderingContext,
    private readonly sizedCanvas: HTMLCanvasElement | OffscreenCanvas | null,
  ) {
    this.gl = gl;
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    this.softwareRendering =
      rendererInfo === null ||
      /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
        String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)),
      );
    this.directProgram = new Program(gl, VERTEX_SHADER, DIRECT_FRAGMENT_SHADER);
    // Single-float sums (see DensityPrecision) need both renderable float
    // targets and blending on them.
    const floatTargets =
      gl.getExtension("EXT_color_buffer_float") !== null &&
      gl.getExtension("EXT_float_blend") !== null;
    this.densityPrograms = !floatTargets
      ? null
      : {
          lines: new Program(gl, VERTEX_SHADER, DENSITY_FRAGMENT_SHADER),
          composite: new Program(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER),
        };
    const textures: Partial<Record<SamplerName, WebGLTexture>> = {};
    for (const name of Object.keys(UNITS) as SamplerName[]) {
      const texture = gl.createTexture();
      if (texture === null) {
        throw new Error("Could not create a WebGL texture");
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures[name] = texture;
    }
    this.textures = textures as Record<SamplerName, WebGLTexture>;
    const vertexArray = gl.createVertexArray();
    if (vertexArray === null) {
      throw new Error("Could not create a WebGL vertex array");
    }
    this.vertexArray = vertexArray;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxSurfaceSize = Math.min(
      this.maxTextureSize,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      viewport[0],
      viewport[1],
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private bind(name: SamplerName): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + UNITS[name]);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[name]);
  }

  /**
   * Starts over for a new set of rows, known by their shuffled draw order:
   * every per-row texture is re-uploaded on demand.
   */
  setRows(rowCount: number, order: Uint32Array): void {
    if (rowCount === this.rowCount && order === this.rowsOrder) {
      return;
    }
    this.disposeBlocks();
    this.rowCount = rowCount;
    this.rowsOrder = order;
    this.layout = textureLayout(rowCount, this.maxTextureSize);
    this.slots = new Map();
    this.slotCapacity = 0;
    this.uploadedOrder = null;
    this.uploadedBins = null;
    // Laid out at the width of the row textures, which follows the row count.
    this.uploadedPalette = null;
    this.selectionTexels = null;
    this.uploadedSelection = null;
    this.setDrawOrder(order);
  }

  /**
   * The order lines are drawn in, a permutation of the rows: only alpha
   * blending, without float render targets, shows it.
   */
  setDrawOrder(order: Uint32Array): void {
    if (order === this.uploadedOrder) {
      return;
    }
    if (order.length !== this.rowCount) {
      throw new Error(`A draw order of ${order.length} rows for ${this.rowCount} rows`);
    }
    const gl = this.gl;
    this.bind("u_order");
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      this.layout.width,
      this.layout.rowsPerColumn,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      padUint32(order, this.layout),
    );
    this.uploadedOrder = order;
  }

  /** Texture slots for the given pixel columns, uploading the ones not on the GPU yet. */
  private slotsFor(columns: ReadonlyArray<Float32Array>): number[] {
    const gl = this.gl;
    const missing = columns.filter((column) => !this.slots.has(column));
    if (this.slots.size + missing.length > this.slotCapacity) {
      // Keep only the columns in use and grow the texture; everything is re-uploaded.
      const capacity = pixelTextureCapacity(
        columns.length,
        this.layout.rowsPerColumn,
        this.maxTextureSize,
      );
      const height = capacity * this.layout.rowsPerColumn;
      this.bind("u_pixels");
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        this.layout.width,
        height,
        0,
        gl.RED,
        gl.FLOAT,
        null,
      );
      this.slots = new Map();
      this.slotCapacity = capacity;
    }
    this.bind("u_pixels");
    for (const column of columns) {
      if (this.slots.has(column)) {
        continue;
      }
      const slot = this.slots.size;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        slot * this.layout.rowsPerColumn,
        this.layout.width,
        this.layout.rowsPerColumn,
        gl.RED,
        gl.FLOAT,
        encodePixelColumn(column, this.layout),
      );
      this.slots.set(column, slot);
    }
    return columns.map((column) => {
      const slot = this.slots.get(column);
      if (slot === undefined) {
        throw new Error("Pixel column was not uploaded");
      }
      return slot;
    });
  }

  setColors({ bins, palette, colorMapBins }: LineColors): void {
    if (colorMapBins > 0 && palette.length !== colorMapBins + 1) {
      throw new Error(
        `A numeric palette holds its ${colorMapBins} color map bins and the missing color, not ${palette.length} colors`,
      );
    }
    this.colorMapBins = colorMapBins;
    const gl = this.gl;
    if (bins !== this.uploadedBins) {
      this.bind("u_bins");
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32UI,
        this.layout.width,
        this.layout.rowsPerColumn,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        padUint32(bins, this.layout),
      );
      this.uploadedBins = bins;
    }
    if (palette !== this.uploadedPalette) {
      const height = Math.max(1, Math.ceil(palette.length / this.layout.width));
      const texels = new Uint8Array(this.layout.width * height * 4);
      palette.forEach(({ r, g, b }, index) => {
        texels.set([r, g, b, 255], index * 4);
      });
      this.bind("u_palette");
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        this.layout.width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        texels,
      );
      this.uploadedPalette = palette;
    }
  }

  /** Per-row selection flags (1 = drawn): the only upload a brush move needs. */
  setSelection(selected: Uint8Array): void {
    if (selected.length !== this.rowCount) {
      throw new Error(`A selection of ${selected.length} rows for ${this.rowCount} rows`);
    }
    const gl = this.gl;
    // Indexed brushes reuse live buffers; cache the uploaded values, not their identity.
    let texels = this.selectionTexels;
    if (texels !== null) {
      let row = 0;
      while (row < selected.length && selected[row] === texels[row]) ++row;
      if (row === selected.length) return;
      texels.set(selected);
      ++this.selectionRevision;
      this.bind("u_selected");
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.layout.width,
        this.layout.rowsPerColumn,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        texels,
      );
      return;
    }
    texels = padUint8(selected, this.layout);
    this.bind("u_selected");
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      this.layout.width,
      this.layout.rowsPerColumn,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      texels,
    );
    this.selectionTexels = texels;
    ++this.selectionRevision;
    this.uploadedSelection = texels.subarray(0, this.rowCount);
  }

  /** Releases the GPU resources; the renderer is unusable afterwards. */
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /**
   * Whether the GPU is still drawing the last frame. A software renderer
   * (SwiftShader on machines without a GPU) can take far longer than a
   * display frame; frames queued behind it delay input too.
   */
  get busy(): boolean {
    const gl = this.gl;
    if (this.inFlight === null) {
      return false;
    }
    if (gl.getSyncParameter(this.inFlight, gl.SYNC_STATUS) !== gl.SIGNALED) {
      return true;
    }
    gl.deleteSync(this.inFlight);
    this.inFlight = null;
    this.finished = {
      milliseconds: performance.now() - this.submittedAt,
      fullQuality: this.inFlightFullQuality,
      fromBlocks: this.inFlightFromBlocks,
      drewEveryRow: this.inFlightDrewEveryRow,
    };
    return false;
  }

  /**
   * The last frame `busy` saw finish, read once: the time from submitting it
   * to the GPU finishing it, accurate to the interval `busy` is polled at.
   */
  finishedFrame(): FinishedFrame | null {
    const finished = this.finished;
    this.finished = null;
    return finished;
  }

  /** Whether lines are tone-mapped from their density (float render targets available). */
  get densityRendering(): boolean {
    return this.densityPrograms !== null;
  }

  /**
   * The formats a frame sums its densities in (see DensityPrecision): a
   * numeric color is divided by a coverage summed next to it in target 0, a
   * categorical one by the coverage sum in target 1.
   */
  private densityPrecision(): DensityPrecision {
    const gl = this.gl;
    return { selectedSums: gl.RGBA32F, coverageSums: gl.RGBA32F, onTop: gl.RGBA32F };
  }

  private densityTargets(
    width: number,
    height: number,
    precision: DensityPrecision,
  ): DensityTargets {
    const fits = (targets: DensityTargets | null): targets is DensityTargets =>
      targets !== null &&
      targets.width === width &&
      targets.height === height &&
      targets.precision.selectedSums === precision.selectedSums &&
      targets.precision.coverageSums === precision.coverageSums &&
      targets.precision.onTop === precision.onTop;
    if (fits(this.density)) return this.density;
    this.releaseTargets(this.density);
    this.releaseTargets(this.spareDensity);
    this.spareDensity = null;
    this.densityContent = null;
    this.density = this.allocateTargets(width, height, precision);
    return this.density;
  }

  /** The spare targets, of the current targets' size (see drawShifted). */
  private spareTargets(): DensityTargets {
    const current = this.density;
    if (current === null) throw new Error("Spare density targets need current ones");
    this.spareDensity ??= this.allocateTargets(current.width, current.height, current.precision);
    return this.spareDensity;
  }

  /**
   * Frees the spare targets once a frame draws every row: only scrolling
   * needs them, and they hold as much as the density targets.
   */
  private releaseSpareTargets(): void {
    this.releaseTargets(this.spareDensity);
    this.spareDensity = null;
  }

  /** Frees what only exact frames use: their density, spare and offscreen targets, and blocks. */
  private releaseLineTargets(): void {
    this.releaseTargets(this.density);
    this.density = null;
    this.densityContent = null;
    this.releaseSpareTargets();
    this.disposeBlocks();
    if (this.directTargets !== null) {
      this.gl.deleteFramebuffer(this.directTargets.framebuffer);
      this.gl.deleteRenderbuffer(this.directTargets.renderbuffer);
      this.directTargets = null;
    }
  }

  /** The offscreen target of a batched frame without float targets, of this size. */
  private directTarget(width: number, height: number): DirectTarget {
    const gl = this.gl;
    const current = this.directTargets;
    if (current !== null && current.width === width && current.height === height) return current;
    if (current !== null) {
      gl.deleteFramebuffer(current.framebuffer);
      gl.deleteRenderbuffer(current.renderbuffer);
      this.directTargets = null;
    }
    const renderbuffer = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (renderbuffer === null || framebuffer === null) {
      throw new Error("Could not create an offscreen line target");
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.directTargets = { framebuffer, renderbuffer, width, height };
    return this.directTargets;
  }

  /** Copies an offscreen frame onto its canvas: the frame's only write to the canvas. */
  private blitToCanvas(frame: LineFrame, source: DirectTarget): void {
    const gl = this.gl;
    this.bindCanvas(frame);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.blitFramebuffer(
      0,
      0,
      source.width,
      source.height,
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Binds the canvas for a frame's final write, first sizing it for the frame
   * when the renderer sizes it (see create). Resizing clears a canvas, and a
   * worker's canvas shows what it holds after every task: a frame drawn over
   * several tasks only resizes and writes it in its last.
   */
  private bindCanvas(frame: Pick<LineFrame, "width" | "height" | "pixelRatio">): void {
    const gl = this.gl;
    const canvas = this.sizedCanvas;
    if (canvas !== null) {
      const { width, height } = this.surfaceSize(frame);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  /**
   * A frame's size in device pixels (see deviceSize), within what this GPU
   * renders: a browser caps a larger canvas's drawing buffer, and targets
   * past the limit could not be allocated.
   */
  private surfaceSize(frame: Pick<LineFrame, "width" | "height" | "pixelRatio">): {
    width: number;
    height: number;
  } {
    const { width, height } = deviceSize(frame);
    return {
      width: Math.min(width, this.maxSurfaceSize),
      height: Math.min(height, this.maxSurfaceSize),
    };
  }

  /** Whether the WebGL context was lost: no frame in flight will finish. */
  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  private releaseTargets(targets: DensityTargets | null): void {
    if (targets === null) return;
    const gl = this.gl;
    gl.deleteFramebuffer(targets.framebuffer);
    gl.deleteTexture(targets.selectedSums);
    gl.deleteTexture(targets.coverageSums);
    gl.deleteTexture(targets.onTop);
  }

  private allocateTargets(
    width: number,
    height: number,
    precision: DensityPrecision,
  ): DensityTargets {
    const gl = this.gl;
    const target = (format: number): WebGLTexture => {
      const texture = gl.createTexture();
      if (texture === null) {
        throw new Error("Could not create a WebGL texture");
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
      return texture;
    };
    const selectedSums = target(precision.selectedSums);
    const coverageSums = target(precision.coverageSums);
    const onTop = target(precision.onTop);
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) {
      throw new Error("Could not create a WebGL framebuffer");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selectedSums, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, coverageSums, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, onTop, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, selectedSums, coverageSums, onTop, precision, width, height };
  }

  /** Records that `targets` hold the density of `frame`, as currently uploaded. */
  private recordDensity(frame: LineFrame, targets: DensityTargets): void {
    this.densityContent = {
      targets,
      style: densityStyle(frame),
      axes: frame.axes.map(({ x, pixels }) => ({ x, pixels })),
      rowsOrder: this.rowsOrder,
      drawOrder: this.uploadedOrder,
      bins: this.uploadedBins,
      palette: this.uploadedPalette,
      colorMapBins: this.colorMapBins,
      selectionRevision: this.selectionRevision,
    };
  }

  /**
   * How many target columns the recorded density moved for `frame` to show
   * it: 0 for the same frame, null unless every input but the axes' common
   * horizontal offset is unchanged and that offset is whole target pixels.
   */
  private densityShift(frame: LineFrame): number | null {
    const content = this.densityContent;
    if (
      content === null ||
      content.targets !== this.density ||
      content.style !== densityStyle(frame) ||
      content.rowsOrder !== this.rowsOrder ||
      content.drawOrder !== this.uploadedOrder ||
      content.bins !== this.uploadedBins ||
      content.palette !== this.uploadedPalette ||
      content.colorMapBins !== this.colorMapBins ||
      content.selectionRevision !== this.selectionRevision ||
      content.axes.length !== frame.axes.length ||
      content.axes.some((axis, index) => axis.pixels !== frame.axes[index].pixels)
    ) {
      return null;
    }
    const offset = frame.axes[0].x - content.axes[0].x;
    // Positions differ from their scroll offset by float rounding only.
    if (
      content.axes.some((axis, index) => Math.abs(frame.axes[index].x - axis.x - offset) > 1e-6)
    ) {
      return null;
    }
    const shift = (offset * content.targets.width) / Math.max(1, frame.width);
    const whole = Math.round(shift);
    return Math.abs(shift - whole) < 1e-6 && Math.abs(whole) < content.targets.width ? whole : null;
  }

  /** Binds the line data and uniforms shared by every line pass; returns the points per segment. */
  private prepareLines(
    program: Program,
    frame: LineFrame,
    target: { width: number; height: number },
  ): number {
    const gl = this.gl;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(program.program);
    for (const [name, unit] of Object.entries(UNITS)) {
      gl.uniform1i(program.uniform(name), unit);
      // Rebound every pass: creating the density targets may have replaced a binding.
      this.bind(name as SamplerName);
    }
    const samples = segmentSamples(frame.axes, frame.curved);
    gl.uniform1i(program.uniform("u_axisCount"), frame.axes.length);
    gl.uniform1i(program.uniform("u_textureWidth"), this.layout.width);
    gl.uniform1i(program.uniform("u_rowsPerColumn"), this.layout.rowsPerColumn);
    gl.uniform1i(program.uniform("u_colorMapBins"), this.colorMapBins);
    gl.uniform1i(program.uniform("u_samples"), samples);
    gl.uniform1i(program.uniform("u_curved"), frame.curved ? 1 : 0);
    gl.uniform2f(
      program.uniform("u_deviceScale"),
      target.width / Math.max(1, frame.width),
      target.height / Math.max(1, frame.height),
    );
    gl.uniform2f(program.uniform("u_viewport"), target.width, target.height);
    gl.uniform1i(program.uniform("u_antialiased"), frame.draft ? 0 : 1);
    // Plain lines cover their pixels fully: coverage() is 1 at v_across = 0.
    gl.uniform1f(program.uniform("u_halfWidth"), lineHalfWidth(frame));
    gl.uniform1i(program.uniform("u_allSelected"), 0);
    return samples;
  }

  private *drawLines(
    program: Program,
    frame: LineFrame,
    samples: number,
    size: BatchSize | null,
  ): Generator<LineBatch> {
    yield* this.drawRows(
      program,
      frame,
      samples,
      0,
      Math.min(frame.drawnRows, this.rowCount),
      size,
    );
  }

  /**
   * Lines of the rows at positions `[start, end)` of the bound order texture,
   * in batches of `size`, yielding each; without a size, in one draw.
   */
  private *drawRows(
    program: Program,
    frame: LineFrame,
    samples: number,
    start: number,
    end: number,
    size: BatchSize | null,
    segments: SegmentRun = { first: 0, count: segmentsPerLine(frame.axes.length) },
  ): Generator<LineBatch> {
    const gl = this.gl;
    gl.uniform1i(program.uniform("u_segmentFirst"), segments.first);
    gl.uniform1i(program.uniform("u_segmentCount"), segments.count);
    // Batches are sized in rows of every segment: a run of fewer segments takes more rows.
    const perRow = segmentsPerLine(frame.axes.length) / segments.count;
    for (let offset = start; offset < end; ) {
      const wanted = size === null ? end - offset : Math.ceil(size.rows * perRow);
      const count = Math.min(wanted, end - offset);
      gl.uniform1i(program.uniform("u_rowOffset"), offset);
      gl.bindVertexArray(this.vertexArray);
      gl.drawArraysInstanced(
        frame.draft ? gl.LINE_STRIP : gl.TRIANGLE_STRIP,
        0,
        frame.draft ? samples : 2 * samples,
        count * segments.count,
      );
      gl.bindVertexArray(null);
      offset += count;
      if (size !== null) {
        yield { size, rows: size.rows, drawn: count / perRow, full: count === wanted };
      }
    }
  }

  /**
   * Worker-only batches leave the compositor time to present input between GPU
   * submissions. With a focus (a brush gesture on one axis), the frame is
   * summed from the focus's retained blocks (see webgl_blocks.ts), first
   * drawing them in batches if the cached ones do not match the frame.
   */
  async drawCooperative(frame: LineFrame, focus: LineFocus | null = null): Promise<void> {
    const gl = this.gl;
    this.submittedAt = performance.now();
    this.inFlightFullQuality = !frame.draft && frame.resolution === 1;
    this.inFlightFromBlocks = false;
    this.inFlightDrewEveryRow = true;
    const layout = this.blockLayout(frame);
    if (
      focus !== null &&
      this.densityPrograms !== null &&
      !frame.draft &&
      blocksFit(layout.width * layout.height, layout.layerBytes)
    ) {
      if (frame.drawnRows !== this.rowCount) {
        throw new Error(`Brush blocks sum every row, not ${frame.drawnRows} of ${this.rowCount}`);
      }
      const blocks =
        this.matchingBlocks(frame, focus) ??
        (focus.active ? await this.buildBlocks(frame, focus) : null);
      if (blocks !== null && this.drawBlockFrame(frame, blocks)) {
        this.inFlightFromBlocks = true;
        this.inFlightDrewEveryRow = false;
        this.inFlight = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return;
      }
      if (blocks === null) this.disposeBlocks();
    } else {
      // A frame that cannot use the blocks frees their memory.
      this.disposeBlocks();
    }
    await this.cooperate(this.drawFrame(frame, true));
    this.inFlight = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /**
   * Runs GPU work in batches of about 6 ms of GPU time, keeping one batch
   * queued behind the one in flight: the GPU never idles while a completion
   * travels back, and no more than two batches wait ahead of the compositor.
   * Each full batch adapts its size from its own rows and time (see
   * BatchSize). Sizes carry over to the next frame, whose rows cost about the
   * same: a small plot then draws in one batch.
   */
  private async cooperate(work: Iterable<LineBatch>): Promise<void> {
    const gl = this.gl;
    const poller = new TaskPoller(this.softwareRendering);
    const queued: { fence: WebGLSync; batch: LineBatch }[] = [];
    /** Waits for a fence, yielding at least once; returns how long the last yield took. */
    const finish = async (fence: WebGLSync): Promise<number> => {
      let lastWait = 0;
      try {
        do {
          // Always yield, including on software GPUs which may finish during flush.
          const waitingAt = performance.now();
          await poller.next();
          lastWait = performance.now() - waitingAt;
          if (gl.isContextLost()) throw new Error("The line renderer lost its WebGL context");
        } while (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED);
      } finally {
        gl.deleteSync(fence);
      }
      return lastWait;
    };
    let completedAt = performance.now();
    /** Waits for the oldest batch and adapts the size it was drawn with. */
    const settleOldest = async (): Promise<void> => {
      const { fence, batch } = queued.shift() as (typeof queued)[number];
      const lastWait = await finish(fence);
      // Batches run back to back, so completions are one batch's GPU time apart;
      // host task delays are not GPU work.
      batch.size?.adapt(batch, performance.now() - completedAt - lastWait);
      completedAt = performance.now();
    };
    try {
      for (const batch of work) {
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (fence === null) throw new Error("Could not fence an exact line batch");
        gl.flush();
        queued.push({ fence, batch });
        if (queued.length === 2) await settleOldest();
      }
      while (queued.length > 0) await settleOldest();
    } finally {
      for (const { fence } of queued) gl.deleteSync(fence);
      poller.close();
    }
  }

  /** The retained blocks, if they were drawn from this frame's geometry, colors and focus. */
  private matchingBlocks(frame: LineFrame, focus: LineFocus): RetainedBlocks | null {
    const blocks = this.blocks;
    if (
      blocks === null ||
      blocks.focusRows !== focus.rows ||
      blocks.focusAxis !== focus.axis ||
      blocks.rowsOrder !== this.rowsOrder ||
      blocks.bins !== this.uploadedBins ||
      blocks.palette !== this.uploadedPalette ||
      blocks.colorMapBins !== this.colorMapBins ||
      blocks.style !== blockStyle(frame) ||
      blocks.axes.length !== frame.axes.length ||
      blocks.axes.some(
        (axis, index) => axis.x !== frame.axes[index].x || axis.pixels !== frame.axes[index].pixels,
      )
    ) {
      return null;
    }
    return blocks;
  }

  /**
   * Draws the focus rows block by block, each into its own layer as if all
   * were selected, in batches (see `cooperate`). Replaces the previous blocks,
   * whose memory is released first.
   */
  private async buildBlocks(frame: LineFrame, focus: LineFocus): Promise<RetainedBlocks> {
    const gl = this.gl;
    const programs = this.densityPrograms;
    if (programs === null) throw new Error("Brush blocks need float render targets");
    if (!(focus.axis >= 0 && focus.axis < frame.axes.length)) {
      throw new Error(`No focus axis ${focus.axis} of ${frame.axes.length}`);
    }
    if (focus.rows.length !== this.rowCount) {
      throw new Error(`A focus of ${focus.rows.length} rows for ${this.rowCount} rows`);
    }
    if (this.uploadedOrder === null) throw new Error("Brush blocks need a draw order");
    this.disposeBlocks();
    const { width, height, valueColors, withOnTop, layerBytes } = this.blockLayout(frame);
    let focused = 0;
    for (let row = 0; row < focus.rows.length; ++row) focused += focus.rows[row] === 0 ? 0 : 1;
    const blockCount = blockCountFor(
      focused,
      width * height,
      layerBytes,
      gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    );
    const partition = partitionRows(
      frame.axes[focus.axis].pixels,
      focus.rows,
      this.uploadedOrder,
      blockCount,
    );
    // Every block, the rows outside the focus last, then two layers per partial slot.
    const slotLayer = partition.starts.length - 1;
    const states = new Uint8Array(slotLayer + 2 * PARTIAL_SLOTS);
    let slotBlockRows = 0;
    for (let block = 0; block + 1 < slotLayer; ++block) {
      slotBlockRows = Math.max(
        slotBlockRows,
        partition.starts[block + 1] - partition.starts[block],
      );
    }
    const slotRows = new Uint32Array(
      this.layout.width *
        Math.max(1, Math.ceil((PARTIAL_SLOTS * slotBlockRows) / this.layout.width)),
    );
    this.blockPasses ??= new BlockPasses(gl);
    const textures: WebGLTexture[] = [];
    let layers: BlockLayers | null = null;
    let blocks: RetainedBlocks;
    try {
      const order = this.rowTexture(padUint32(partition.order, this.layout));
      textures.push(order);
      const slotOrder = this.rowTexture(slotRows);
      textures.push(slotOrder);
      layers = new BlockLayers(gl, width, height, states.length, valueColors, withOnTop);
      blocks = {
        layers,
        partition,
        states,
        slotLayer,
        selection: new BlockSelection(partition),
        slots: new PartialSlots(slotBlockRows),
        order,
        slotRows,
        slotOrder,
        focusRows: focus.rows,
        focusAxis: focus.axis,
        rowsOrder: this.rowsOrder,
        bins: this.uploadedBins,
        palette: this.uploadedPalette,
        colorMapBins: this.colorMapBins,
        style: blockStyle(frame),
        axes: frame.axes.map(({ x, pixels }) => ({ x, pixels })),
      };
      const passes = this.blockPasses;
      await this.cooperate(this.drawBlockLayers(frame, blocks, passes, programs.lines));
    } catch (error) {
      layers?.dispose();
      for (const texture of textures) gl.deleteTexture(texture);
      throw error;
    }
    this.blocks = blocks;
    return blocks;
  }

  /** A per-row unsigned integer texture in the row layout, for the line pass's order. */
  private rowTexture(rows: Uint32Array): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (texture === null) throw new Error("Could not create a block order texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      this.layout.width,
      rows.length / this.layout.width,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      rows,
    );
    return texture;
  }

  /** The size and format of a frame's block layers (see BlockLayers). */
  private blockLayout(frame: LineFrame) {
    const { width, height } = this.surfaceSize(frame);
    const valueColors = this.colorMapBins > 0;
    const withOnTop = valueColors && frame.colorMode !== "mean";
    return {
      width: Math.max(1, Math.ceil(width * frame.resolution)),
      height: Math.max(1, Math.ceil(height * frame.resolution)),
      valueColors,
      withOnTop,
      layerBytes: blockLayerBytes(valueColors, withOnTop),
    };
  }

  private *drawBlockLayers(
    frame: LineFrame,
    blocks: RetainedBlocks,
    passes: BlockPasses,
    lines: Program,
  ): Generator<LineBatch> {
    const gl = this.gl;
    const { layers, partition } = blocks;
    this.uploadAxes(frame);
    const samples = this.startLinePass(lines, frame, layers, true);
    gl.activeTexture(gl.TEXTURE0 + UNITS.u_order);
    gl.bindTexture(gl.TEXTURE_2D, blocks.order);
    for (let block = 0; block < blocks.slotLayer; ++block) {
      passes.bindLayer(layers, block, true);
      yield* this.drawRows(
        lines,
        frame,
        samples,
        partition.starts[block],
        partition.starts[block + 1],
        this.lineBatches,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
  }

  /**
   * Draws a frame from retained blocks: the partly selected ones row by row,
   * into slots or directly, then every layer as selected or deselected, then
   * the usual tone mapping. Returns false, drawing nothing, when so many rows
   * are partly selected that drawing every row is cheaper.
   */
  private drawBlockFrame(frame: LineFrame, blocks: RetainedBlocks): boolean {
    const gl = this.gl;
    const programs = this.densityPrograms;
    const selection = this.uploadedSelection;
    const passes = this.blockPasses;
    if (programs === null || selection === null || passes === null) {
      throw new Error("Brush blocks need float targets, a selection and their passes");
    }
    const blockStates = blocks.states.subarray(0, blocks.slotLayer);
    const partialRows = blocks.selection.update(selection, blockStates);
    if (partialRows > this.rowCount / 2) return false;
    const plan = blocks.slots.plan(blocks.partition, selection, blockStates);
    for (let slot = 0; slot < PARTIAL_SLOTS; ++slot) {
      const used = ((plan.used >> slot) & 1) !== 0;
      blocks.states[blocks.slotLayer + 2 * slot] = used ? LAYER_SELECTED : LAYER_SKIPPED;
      blocks.states[blocks.slotLayer + 2 * slot + 1] = used ? LAYER_CONTEXT : LAYER_SKIPPED;
    }
    const { order, starts } = blocks.partition;
    const drawOnce = (samples: number, start: number, end: number): void => {
      for (const _ of this.drawRows(programs.lines, frame, samples, start, end, null)) {
        // One submission, which never yields: partly selected blocks are a small share of the rows.
      }
    };
    this.uploadAxes(frame);
    if (plan.draw.length > 0) {
      // The rows of every half drawn, one after another.
      const ranges: [HalfDraw, number, number][] = [];
      let at = 0;
      for (const draw of plan.draw) {
        const begin = at;
        for (const position of draw.positions) {
          blocks.slotRows[at++] = order[starts[draw.block] + position];
        }
        ranges.push([draw, begin, at]);
      }
      gl.activeTexture(gl.TEXTURE0 + UNITS.u_order);
      gl.bindTexture(gl.TEXTURE_2D, blocks.slotOrder);
      const texelRows = Math.ceil(at / this.layout.width);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.layout.width,
        texelRows,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        blocks.slotRows.subarray(0, texelRows * this.layout.width),
      );
      const samples = this.startLinePass(programs.lines, frame, blocks.layers, true);
      gl.activeTexture(gl.TEXTURE0 + UNITS.u_order);
      gl.bindTexture(gl.TEXTURE_2D, blocks.slotOrder);
      for (const [{ slot, half, clear }, begin, end] of ranges) {
        passes.bindLayer(blocks.layers, blocks.slotLayer + 2 * slot + half, clear);
        drawOnce(samples, begin, end);
      }
    }
    const targets = this.densityTargets(
      blocks.layers.width,
      blocks.layers.height,
      this.densityPrecision(),
    );
    this.bindDensityTargets(frame, targets);
    const samples = this.startLinePass(programs.lines, frame, targets, false);
    if (plan.overflow.length > 0) {
      gl.activeTexture(gl.TEXTURE0 + UNITS.u_order);
      gl.bindTexture(gl.TEXTURE_2D, blocks.order);
      for (const block of plan.overflow) drawOnce(samples, starts[block], starts[block + 1]);
    }
    passes.accumulate(blocks.layers, blocks.states);
    gl.disable(gl.BLEND);
    this.recordDensity(frame, targets);
    if (!frame.transient) this.releaseSpareTargets();
    this.composite(frame, targets);
    return true;
  }

  private disposeBlocks(): void {
    if (this.blocks === null) return;
    this.blocks.layers.dispose();
    this.gl.deleteTexture(this.blocks.order);
    this.gl.deleteTexture(this.blocks.slotOrder);
    this.blocks = null;
  }

  /** Draws a frame and marks it in flight until the GPU has finished it (see `busy`). */
  draw(frame: LineFrame): void {
    const gl = this.gl;
    this.submittedAt = performance.now();
    this.inFlightFullQuality = !frame.draft && frame.resolution === 1;
    this.inFlightFromBlocks = false;
    this.inFlightDrewEveryRow = true;
    for (const _ of this.drawFrame(frame)) {
      // The synchronous path submits one complete pass without waiting between rows.
    }
    if (this.inFlight !== null) {
      gl.deleteSync(this.inFlight);
    }
    this.inFlight = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /**
   * Presents a continuous density image, top-down ImageData, on the canvas
   * of `frame` without per-row GPU work.
   */
  present(
    { pixels, width, height }: { pixels: Uint8ClampedArray; width: number; height: number },
    frame: Pick<LineFrame, "width" | "height" | "pixelRatio">,
  ): void {
    const gl = this.gl;
    // Continuous density took over: no exact frame will reuse these.
    this.releaseLineTargets();
    this.submittedAt = performance.now();
    this.inFlightFullQuality = false;
    this.inFlightFromBlocks = false;
    this.inFlightDrewEveryRow = false;
    this.imageProgram ??= new Program(gl, COMPOSITE_VERTEX_SHADER, IMAGE_FRAGMENT_SHADER);
    this.imageTexture ??= gl.createTexture();
    if (this.imageTexture === null) {
      throw new Error("Could not create a density image texture");
    }
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook.
    gl.useProgram(this.imageProgram.program);
    gl.uniform1i(this.imageProgram.uniform("u_image"), 0);
    this.bindCanvas(frame);
    gl.uniform2f(
      this.imageProgram.uniform("u_viewport"),
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    );
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (this.inFlight !== null) {
      gl.deleteSync(this.inFlight);
    }
    this.inFlight = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** Draws a frame; `batched`, in the cooperative batches it yields (see cooperate). */
  private *drawFrame(frame: LineFrame, batched = false): Generator<LineBatch> {
    const gl = this.gl;
    const size = batched ? this.lineBatches : null;
    this.uploadAxes(frame);
    const { width, height } = this.surfaceSize(frame);
    if (this.rowCount === 0 || frame.axes.length === 0) {
      this.bindCanvas(frame);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const contextColor = [
      frame.contextColor.r / 255,
      frame.contextColor.g / 255,
      frame.contextColor.b / 255,
    ] as const;
    gl.enable(gl.BLEND);

    if (this.densityPrograms === null) {
      // A batched frame draws offscreen, so its canvas never shows part of it.
      const offscreen = batched ? this.directTarget(width, height) : null;
      if (offscreen === null) {
        this.bindCanvas(frame);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen.framebuffer);
        gl.viewport(0, 0, width, height);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Deselected lines first, then the selection over them.
      const program = this.directProgram;
      const samples = this.prepareLines(program, frame, { width, height });
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(
        program.uniform("u_alpha"),
        Math.min(2 / Math.max(1, frame.selectedCount) ** 0.3, 1),
      );
      gl.uniform3f(program.uniform("u_contextColor"), ...contextColor);
      gl.uniform1f(
        program.uniform("u_contextAlpha"),
        frame.contextAlpha * Math.min(1 / Math.max(1, frame.contextCount) ** 0.3, 1),
      );
      gl.uniform1i(program.uniform("u_keep"), DRAW_CONTEXT);
      yield* this.drawLines(program, frame, samples, size);
      gl.uniform1i(program.uniform("u_keep"), DRAW_SELECTED);
      yield* this.drawLines(program, frame, samples, size);
      if (offscreen !== null) this.blitToCanvas(frame, offscreen);
      return;
    }

    // One pass accumulates both layers; a second tone-maps them onto the canvas.
    const targets = this.densityTargets(
      Math.max(1, Math.ceil(width * frame.resolution)),
      Math.max(1, Math.ceil(height * frame.resolution)),
      this.densityPrecision(),
    );
    // Only frames of a motion may keep the previous frame's picture (see LineFrame.transient).
    const shift = frame.transient ? this.densityShift(frame) : null;
    if (shift !== null && (yield* this.drawShifted(frame, shift, batched))) {
      this.inFlightDrewEveryRow = false;
      return;
    }
    const { lines } = this.densityPrograms;
    this.bindDensityTargets(frame, targets);
    const samples = this.startLinePass(lines, frame, targets, false);
    yield* this.drawLines(lines, frame, samples, size);
    gl.disable(gl.BLEND);
    this.recordDensity(frame, targets);
    // Kept through a scroll, whose frames may draw every row between moves.
    if (!frame.transient) this.releaseSpareTargets();
    this.composite(frame, targets);
  }

  /**
   * Draws a frame whose density is the recorded one moved `shift` target
   * columns, as a horizontal scroll moves it: copies the moved density into
   * the spare targets, draws into the exposed columns, in batches, only the
   * segments that reach them, and tone-maps. A frame of the same density only
   * tone-maps. Exposed columns are drawn exactly as a full frame draws them;
   * moved ones keep the earlier frame's picture, whose float vertex positions
   * a move does not translate exactly. Returns false, drawing nothing, when the
   * exposed columns need every segment: drawing every row is then cheaper.
   */
  private *drawShifted(
    frame: LineFrame,
    shift: number,
    batched: boolean,
  ): Generator<LineBatch, boolean> {
    const gl = this.gl;
    const programs = this.densityPrograms;
    const source = this.density;
    if (programs === null || source === null) {
      throw new Error("A shifted frame needs recorded density targets");
    }
    if (shift === 0) {
      gl.disable(gl.BLEND);
      this.composite(frame, source);
      return true;
    }
    const [from, to] = shift > 0 ? [0, shift] : [source.width + shift, source.width];
    const scale = source.width / Math.max(1, frame.width);
    const margin = MITER_LIMIT * (Math.max(lineHalfWidth(frame), 0.5) + 1) + 1;
    const segments = segmentsCovering(frame.axes, scale, margin, from, to);
    if (segments?.count === segmentsPerLine(frame.axes.length)) return false;
    const target = this.spareTargets();
    this.shiftProgram ??= new Program(gl, COMPOSITE_VERTEX_SHADER, SHIFT_FRAGMENT_SHADER);
    const program = this.shiftProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(program.program);
    for (const name of ["selectedSums", "coverageSums", "onTop"] as const) {
      gl.activeTexture(gl.TEXTURE0 + DENSITY_UNITS[name]);
      gl.bindTexture(gl.TEXTURE_2D, source[name]);
      gl.uniform1i(program.uniform(`u_${name}`), DENSITY_UNITS[name]);
    }
    gl.uniform1i(program.uniform("u_shift"), shift);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    for (const unit of Object.values(DENSITY_UNITS)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    // The copy is its own batch, so its time is not charged to the strip's rows.
    if (batched && segments !== null) yield { size: null, rows: 0, drawn: 0, full: true };
    if (segments !== null) {
      // Only the exposed columns of the spare targets, which the copy left empty.
      this.bindDensityTargets(frame, target, false);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(from, 0, to - from, target.height);
      const samples = this.startLinePass(programs.lines, frame, target, false);
      const rows = Math.min(frame.drawnRows, this.rowCount);
      // A strip row costs no more than a full row: start from that size.
      if (batched) this.stripBatches ??= new BatchSize(this.lineBatches.rows);
      const size = batched ? this.stripBatches : null;
      try {
        yield* this.drawRows(programs.lines, frame, samples, 0, rows, size, segments);
      } finally {
        gl.disable(gl.SCISSOR_TEST);
      }
    }
    gl.disable(gl.BLEND);
    this.spareDensity = source;
    this.density = target;
    this.recordDensity(frame, target);
    this.composite(frame, target);
    return true;
  }

  /** Uploads the axes texture: each axis's x and the texture slot of its pixel column. */
  private uploadAxes(frame: LineFrame): void {
    const gl = this.gl;
    const slots = this.slotsFor(frame.axes.map((axis) => axis.pixels));
    const axesTexels = new Float32Array(Math.max(1, frame.axes.length) * 4);
    frame.axes.forEach((axis, index) => {
      axesTexels.set([axis.x, slots[index], 0, 0], index * 4);
    });
    this.bind("u_axes");
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      Math.max(1, frame.axes.length),
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      axesTexels,
    );
  }

  /**
   * Binds the density targets, the line on top only in the modes that show
   * it, and clears them unless `clear` is false.
   */
  private bindDensityTargets(frame: LineFrame, targets: DensityTargets, clear = true): void {
    const gl = this.gl;
    // The line on top only matters in the modes that show it; others skip its bandwidth.
    const withOnTop = this.colorMapBins > 0 && frame.colorMode !== "mean";
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      withOnTop ? gl.COLOR_ATTACHMENT2 : gl.NONE,
    ]);
    gl.viewport(0, 0, targets.width, targets.height);
    if (!clear) return;
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    if (withOnTop) {
      gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
    }
  }

  /**
   * Sets up a density pass of the line program into the bound targets, of
   * `target`'s size: colors add up and alphas keep the maximum, in every
   * target. Returns the points per segment.
   */
  private startLinePass(
    program: Program,
    frame: LineFrame,
    target: { width: number; height: number },
    allSelected: boolean,
  ): number {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);
    const samples = this.prepareLines(program, frame, target);
    gl.uniform1i(program.uniform("u_keep"), DRAW_ALL);
    gl.uniform1i(program.uniform("u_valueColors"), this.colorMapBins > 0 ? 1 : 0);
    gl.uniform1i(program.uniform("u_colorMode"), COLOR_MODE_CODES[frame.colorMode]);
    gl.uniform1f(program.uniform("u_onTopLevels"), ON_TOP_COVERAGE_LEVELS);
    gl.uniform1i(program.uniform("u_allSelected"), allSelected ? 1 : 0);
    return samples;
  }

  /**
   * Tone-maps the density targets onto the canvas (see
   * COMPOSITE_FRAGMENT_SHADER), every pixel of it: a frame's only write to
   * its canvas.
   */
  private composite(frame: LineFrame, targets: DensityTargets): void {
    const gl = this.gl;
    const programs = this.densityPrograms;
    if (programs === null) throw new Error("Compositing needs float render targets");
    const { composite } = programs;
    const valueColors = this.colorMapBins > 0;
    this.bindCanvas(frame);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(composite.program);
    for (const name of ["selectedSums", "coverageSums", "onTop"] as const) {
      gl.activeTexture(gl.TEXTURE0 + DENSITY_UNITS[name]);
      gl.bindTexture(gl.TEXTURE_2D, targets[name]);
      gl.uniform1i(composite.uniform(`u_${name}`), DENSITY_UNITS[name]);
    }
    this.bind("u_palette");
    gl.uniform1i(composite.uniform("u_palette"), UNITS.u_palette);
    gl.uniform1i(composite.uniform("u_paletteWidth"), this.layout.width);
    gl.uniform1i(composite.uniform("u_valueColors"), valueColors ? 1 : 0);
    gl.uniform1i(composite.uniform("u_colorMapBins"), this.colorMapBins);
    gl.uniform1i(composite.uniform("u_colorMode"), COLOR_MODE_CODES[frame.colorMode]);
    gl.uniform1f(composite.uniform("u_onTopLevels"), ON_TOP_COVERAGE_LEVELS);
    gl.uniform1f(
      composite.uniform("u_selectedReference"),
      densityReference(frame.selectedCount, frame.height),
    );
    gl.uniform1f(
      composite.uniform("u_contextReference"),
      densityReference(frame.contextCount, frame.height),
    );
    gl.uniform3f(
      composite.uniform("u_contextColor"),
      frame.contextColor.r / 255,
      frame.contextColor.g / 255,
      frame.contextColor.b / 255,
    );
    gl.uniform1f(composite.uniform("u_contextAlpha"), frame.contextAlpha);
    gl.uniform1f(composite.uniform("u_resolution"), targets.width / gl.drawingBufferWidth);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    // Unbound so the next line pass, which renders into them, has no feedback loop.
    for (const unit of Object.values(DENSITY_UNITS)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}
