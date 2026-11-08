/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { ColorMode, RGB } from "../lib/colors";
import { SPLINE_HANDLE } from "./spline";
import {
  encodePixelColumn,
  MISSING_THRESHOLD,
  padUint8,
  padUint32,
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
   * Anti-aliased strips, or one-pixel lines: half the fragments, for the
   * frames of a brush or axis drag over many rows (see ParallelPlot).
   */
  antialiased: boolean;
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

/** How rows are colored: a palette color per row, by bin. */
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
 * footprint (see COVERAGE) plus half a device pixel, where coverage reaches
 * zero; `v_across` is the signed distance from the center line in device
 * pixels, from which fragments take their coverage.
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
uniform int u_textureWidth;
uniform int u_rowsPerColumn;
uniform int u_colorMapBins;
uniform int u_samples;
uniform int u_keep;
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
    xLeft = xRight - 15.0;
    yLeft = yRight;
  } else if (s.hasLeft) {
    // Stub leaving the last axis, or an axis before a missing value.
    xLeft = axis(segment - 1).x;
    xRight = xLeft + 15.0;
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
  return vec2(axis(joint).x + direction * 15.0, jointY) * u_deviceScale;
}

void main() {
  int segments = u_axisCount + 1;
  int line = gl_InstanceID / segments;
  int segment = gl_InstanceID - line * segments;
  int row = int(texelFetch(u_order, at(line), 0).r);
  bool selected = texelFetch(u_selected, at(row), 0).r > 0u;
  bool kept = u_keep == ${DRAW_ALL} || (u_keep == ${DRAW_SELECTED}) == selected;

  Segment current = segmentOf(segment, row);
  if (!kept || !current.drawn) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_rgb = vec3(0.0);
    v_value = -1.0;
    v_selected = 0.0;
    v_across = 0.0;
    return;
  }

  // Strips take two vertices per point, one on each side; plain lines one.
  int point = u_antialiased ? gl_VertexID / 2 : gl_VertexID;
  float side = !u_antialiased ? 0.0 : (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  float step = 1.0 / float(u_samples - 1);
  float t = float(point) * step;
  vec2 position = pointOf(current, t);
  float extent = max(u_halfWidth, 0.5) + 0.5;
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
}
`;

/**
 * Coverage of a device pixel `v_across` from the center of a line
 * `2 * u_halfWidth` wide: the overlap of the pixel with the line, measured
 * across it. A line narrower than a pixel keeps a one-pixel footprint and
 * fades with its width, as Canvas 2D hairlines do, so its coverage summed
 * across the line stays its width wherever it falls between pixel centers.
 */
const COVERAGE = `
uniform float u_halfWidth;
in float v_across;
float coverage() {
  float halfFootprint = max(u_halfWidth, 0.5);
  return clamp(halfFootprint + 0.5 - abs(v_across), 0.0, 1.0) * min(2.0 * u_halfWidth, 1.0);
}
`;

/** `u_colorMode` of the density passes, one per ColorMode. */
const COLOR_MODE_CODES: Record<ColorMode, number> = { mean: 0, lowest: 1, highest: 2 };

/**
 * The line that a pixel shows on top in the "lowest" and "highest" color
 * modes, kept by MAX blending as one float: 1 + rank * ON_TOP_RANKS +
 * coverage, both quantized to integers below ON_TOP_RANKS, where the rank is
 * the value counted toward the end on top. The highest rank wins, then the
 * highest coverage; 0 means no line. Exact in single floats (below 2^24).
 */
const ON_TOP_RANKS = 1024;

/**
 * Accumulates line density into two targets (see `draw`). Target 0 adds up,
 * per selected line, its coverage-weighted color (r, g, b) and its coverage
 * (a). The color is the line's palette color for a categorical column; for a
 * numeric one, its value on the color map (r) and, for a missing value, its
 * coverage (g) instead. Target 1 keeps the maximum of its color channels: the
 * selected and deselected peak coverages and the line on top (see
 * ON_TOP_RANKS); and adds up the deselected coverage in alpha.
 */
const DENSITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${COVERAGE}
uniform bool u_valueColors;
uniform int u_colorMode;
in vec3 v_rgb;
flat in float v_value;
in float v_selected;
layout(location = 0) out vec4 selectedSums;
layout(location = 1) out vec4 layers;
void main() {
  float covered = coverage();
  float selectedCoverage = v_selected * covered;
  float contextCoverage = (1.0 - v_selected) * covered;
  bool valued = v_value >= 0.0;
  selectedSums = !u_valueColors
    ? vec4(v_rgb * selectedCoverage, selectedCoverage)
    : vec4(valued ? v_value * selectedCoverage : 0.0, valued ? 0.0 : selectedCoverage, 0.0,
        selectedCoverage);
  float onTop = 0.0;
  if (u_colorMode != ${COLOR_MODE_CODES.mean} && valued && selectedCoverage > 0.0) {
    float rank = u_colorMode == ${COLOR_MODE_CODES.highest} ? v_value : 1.0 - v_value;
    float steps = ${(ON_TOP_RANKS - 1).toFixed(1)};
    onTop = 1.0 + round(rank * steps) * ${ON_TOP_RANKS.toFixed(1)} + round(selectedCoverage * steps);
  }
  layers = vec4(selectedCoverage, contextCoverage, onTop, contextCoverage);
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
 */
const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_selectedSums;
uniform sampler2D u_layers;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
uniform bool u_valueColors;
uniform int u_colorMapBins;
uniform int u_colorMode;
uniform float u_selectedReference;
uniform float u_contextReference;
uniform vec3 u_contextColor;
uniform float u_contextAlpha;
out vec4 color;
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
vec3 selectedColor(vec4 sums, vec4 layers) {
  if (!u_valueColors) {
    return sums.rgb / sums.a;
  }
  float valuedCoverage = sums.a - sums.g;
  vec3 mixed = valuedCoverage > 0.0 ? colorMapAt(sums.r / valuedCoverage) : vec3(0.0);
  mixed = mix(mixed, paletteColor(u_colorMapBins), sums.g / sums.a);
  if (layers.b <= 0.0) {
    return mixed;
  }
  float onTop = layers.b - 1.0;
  float steps = ${(ON_TOP_RANKS - 1).toFixed(1)};
  float rank = floor(onTop / ${ON_TOP_RANKS.toFixed(1)}) / steps;
  float coverage = mod(onTop, ${ON_TOP_RANKS.toFixed(1)}) / steps;
  float value = u_colorMode == ${COLOR_MODE_CODES.highest} ? rank : 1.0 - rank;
  return mix(mixed, colorMapAt(value), min(coverage / layers.r, 1.0));
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 sums = texelFetch(u_selectedSums, pixel, 0);
  vec4 layers = texelFetch(u_layers, pixel, 0);
  float selectedAlpha = toneMapped(sums.a, layers.r, u_selectedReference);
  float contextAlpha = u_contextAlpha * toneMapped(layers.a, layers.g, u_contextReference);
  vec3 selectedColor = sums.a > 0.0 ? selectedColor(sums, layers) : vec3(0.0);
  color = vec4(
    selectedColor * selectedAlpha + u_contextColor * contextAlpha * (1.0 - selectedAlpha),
    selectedAlpha + contextAlpha * (1.0 - selectedAlpha)
  );
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
const SELECTED_SUMS_UNIT = 6;
const LAYERS_UNIT = 7;

/**
 * Lines crossing a pixel at which the density reaches full opacity. Densities
 * scale with the line count per pixel of plot height, so the reference does
 * too; a single line always stays visible.
 */
export function densityReference(lineCount: number, plotHeight: number): number {
  return Math.max(2, (12 * lineCount) / Math.max(1, plotHeight));
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error("Could not create a WebGL shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`WebGL shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
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
    const program = gl.createProgram();
    if (program === null) {
      throw new Error("Could not create a WebGL program");
    }
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
  }

  uniform(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.locations.get(name) ?? null;
  }
}

/** Float render targets the line pass accumulates densities into (see DENSITY_FRAGMENT_SHADER). */
interface DensityTargets {
  framebuffer: WebGLFramebuffer;
  selectedSums: WebGLTexture;
  layers: WebGLTexture;
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
  /** Density accumulation then tone mapping, when float render targets exist. */
  private readonly densityPrograms: {
    lines: Program;
    composite: Program;
    /** Sets each target's blending (see DENSITY_FRAGMENT_SHADER). */
    indexedBlending: OES_draw_buffers_indexed;
  } | null;
  /** Alpha-blended lines, the fallback without float render targets. */
  private readonly directProgram: Program;
  private density: DensityTargets | null = null;
  private readonly textures: Record<SamplerName, WebGLTexture>;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly maxTextureSize: number;
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
  private uploadedSelection: Uint8Array | null = null;

  /** A renderer on `canvas`, or null when WebGL2 is unavailable. */
  static create(canvas: HTMLCanvasElement): WebGLLineRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    return gl === null ? null : new WebGLLineRenderer(gl);
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.directProgram = new Program(gl, VERTEX_SHADER, DIRECT_FRAGMENT_SHADER);
    // Densities sum thousands of coverages per pixel: a half-float sum stops
    // growing once its spacing exceeds twice the added coverage, at a point
    // that depends on that coverage, so the summed colors of a dense bundle
    // drift from pixel to pixel. They are summed in single floats, which need
    // both renderable float targets and blending on them, and the two
    // targets blend differently.
    const floatTargets =
      gl.getExtension("EXT_color_buffer_float") !== null &&
      gl.getExtension("EXT_float_blend") !== null;
    const indexedBlending = gl.getExtension("OES_draw_buffers_indexed");
    this.densityPrograms =
      !floatTargets || indexedBlending === null
        ? null
        : {
            lines: new Program(gl, VERTEX_SHADER, DENSITY_FRAGMENT_SHADER),
            composite: new Program(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER),
            indexedBlending,
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
    this.rowCount = rowCount;
    this.rowsOrder = order;
    this.layout = textureLayout(rowCount, this.maxTextureSize);
    this.slots = new Map();
    this.slotCapacity = 0;
    this.uploadedOrder = null;
    this.uploadedBins = null;
    // Laid out at the width of the row textures, which follows the row count.
    this.uploadedPalette = null;
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
      const capacity = Math.max(8, 2 * columns.length);
      const height = capacity * this.layout.rowsPerColumn;
      if (height > this.maxTextureSize) {
        throw new Error(`Too many columns for one WebGL texture (${capacity})`);
      }
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
    if (selected === this.uploadedSelection) {
      return;
    }
    const gl = this.gl;
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
      padUint8(selected, this.layout),
    );
    this.uploadedSelection = selected;
  }

  /** Releases the GPU resources; the renderer is unusable afterwards. */
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Whether lines are tone-mapped from their density (float render targets available). */
  get densityRendering(): boolean {
    return this.densityPrograms !== null;
  }

  private densityTargets(width: number, height: number): DensityTargets {
    if (this.density !== null && this.density.width === width && this.density.height === height) {
      return this.density;
    }
    const gl = this.gl;
    if (this.density !== null) {
      gl.deleteFramebuffer(this.density.framebuffer);
      gl.deleteTexture(this.density.selectedSums);
      gl.deleteTexture(this.density.layers);
    }
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
    const selectedSums = target(gl.RGBA32F);
    const layers = target(gl.RGBA32F);
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) {
      throw new Error("Could not create a WebGL framebuffer");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selectedSums, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, layers, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.density = { framebuffer, selectedSums, layers, width, height };
    return this.density;
  }

  /** Binds the line data and uniforms shared by every line pass; returns the points per segment. */
  private prepareLines(program: Program, frame: LineFrame): number {
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
      gl.drawingBufferWidth / Math.max(1, frame.width),
      gl.drawingBufferHeight / Math.max(1, frame.height),
    );
    gl.uniform2f(program.uniform("u_viewport"), gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1i(program.uniform("u_antialiased"), frame.antialiased ? 1 : 0);
    // Plain lines cover their pixels fully: coverage() is 1 at v_across = 0.
    gl.uniform1f(
      program.uniform("u_halfWidth"),
      frame.antialiased ? (frame.lineWidth * frame.pixelRatio) / 2 : 0.5,
    );
    return samples;
  }

  private drawLines(frame: LineFrame, samples: number): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vertexArray);
    gl.drawArraysInstanced(
      frame.antialiased ? gl.TRIANGLE_STRIP : gl.LINE_STRIP,
      0,
      frame.antialiased ? 2 * samples : samples,
      this.rowCount * segmentsPerLine(frame.axes.length),
    );
    gl.bindVertexArray(null);
  }

  draw(frame: LineFrame): void {
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

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.rowCount === 0 || frame.axes.length === 0) {
      return;
    }
    const contextColor = [
      frame.contextColor.r / 255,
      frame.contextColor.g / 255,
      frame.contextColor.b / 255,
    ] as const;
    gl.enable(gl.BLEND);

    if (this.densityPrograms === null) {
      // Deselected lines first, then the selection over them.
      const program = this.directProgram;
      const samples = this.prepareLines(program, frame);
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
      this.drawLines(frame, samples);
      gl.uniform1i(program.uniform("u_keep"), DRAW_SELECTED);
      this.drawLines(frame, samples);
      return;
    }

    // One pass accumulates both layers; a second tone-maps them onto the canvas.
    const targets = this.densityTargets(width, height);
    const { lines, composite, indexedBlending } = this.densityPrograms;
    const valueColors = this.colorMapBins > 0;
    const colorMode = COLOR_MODE_CODES[frame.colorMode];
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.blendFunc(gl.ONE, gl.ONE);
    indexedBlending.blendEquationiOES(0, gl.FUNC_ADD);
    indexedBlending.blendEquationSeparateiOES(1, gl.MAX, gl.FUNC_ADD);
    const samples = this.prepareLines(lines, frame);
    gl.uniform1i(lines.uniform("u_keep"), DRAW_ALL);
    gl.uniform1i(lines.uniform("u_valueColors"), valueColors ? 1 : 0);
    gl.uniform1i(lines.uniform("u_colorMode"), colorMode);
    this.drawLines(frame, samples);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0 + SELECTED_SUMS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, targets.selectedSums);
    gl.activeTexture(gl.TEXTURE0 + LAYERS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, targets.layers);
    this.bind("u_palette");
    gl.uniform1i(composite.uniform("u_selectedSums"), SELECTED_SUMS_UNIT);
    gl.uniform1i(composite.uniform("u_layers"), LAYERS_UNIT);
    gl.uniform1i(composite.uniform("u_palette"), UNITS.u_palette);
    gl.uniform1i(composite.uniform("u_paletteWidth"), this.layout.width);
    gl.uniform1i(composite.uniform("u_valueColors"), valueColors ? 1 : 0);
    gl.uniform1i(composite.uniform("u_colorMapBins"), this.colorMapBins);
    gl.uniform1i(composite.uniform("u_colorMode"), colorMode);
    gl.uniform1f(
      composite.uniform("u_selectedReference"),
      densityReference(frame.selectedCount, frame.height),
    );
    gl.uniform1f(
      composite.uniform("u_contextReference"),
      densityReference(frame.contextCount, frame.height),
    );
    gl.uniform3f(composite.uniform("u_contextColor"), ...contextColor);
    gl.uniform1f(composite.uniform("u_contextAlpha"), frame.contextAlpha);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    // Unbound so the next line pass, which renders into them, has no feedback loop.
    gl.activeTexture(gl.TEXTURE0 + SELECTED_SUMS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0 + LAYERS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
