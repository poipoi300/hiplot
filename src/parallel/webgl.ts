/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { RGB } from "../lib/colors";
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
  /** Selected and deselected line counts, which set the density scale. */
  selectedCount: number;
  contextCount: number;
  /** Color and peak opacity of the deselected lines. */
  contextColor: RGB;
  contextAlpha: number;
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
 * One instance per segment of a line. A segment is a triangle strip through
 * `u_samples` points along it, widened on both sides by the half line width
 * plus one device pixel; `v_across` is the signed distance from the center
 * line in device pixels, from which fragments take their coverage.
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
uniform int u_samples;
uniform int u_keep;
uniform bool u_curved;
uniform vec2 u_deviceScale;
uniform vec2 u_viewport;
uniform float u_halfWidth;

out vec3 v_rgb;
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

void main() {
  int segments = u_axisCount + 1;
  int line = gl_InstanceID / segments;
  int segment = gl_InstanceID - line * segments;
  int row = int(texelFetch(u_order, at(line), 0).r);
  bool selected = texelFetch(u_selected, at(row), 0).r > 0u;
  bool kept = u_keep == ${DRAW_ALL} || (u_keep == ${DRAW_SELECTED}) == selected;

  float yLeft = segment >= 1 ? pixelY(segment - 1, row) : ${MISSING_THRESHOLD * 10};
  float yRight = segment < u_axisCount ? pixelY(segment, row) : ${MISSING_THRESHOLD * 10};
  bool hasLeft = yLeft > ${MISSING_THRESHOLD};
  bool hasRight = yRight > ${MISSING_THRESHOLD};
  if (!kept || (!hasLeft && !hasRight)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_rgb = vec3(0.0);
    v_selected = 0.0;
    v_across = 0.0;
    return;
  }
  float xLeft;
  float xRight;
  float slopeLeft = 0.0;
  float slopeRight = 0.0;
  if (hasLeft && hasRight) {
    xLeft = axis(segment - 1).x;
    xRight = axis(segment).x;
    if (u_curved) {
      slopeLeft = slopeAt(segment - 1, row, yLeft);
      slopeRight = slopeAt(segment, row, yRight);
    }
  } else if (hasRight) {
    // Stub leading into the first axis, or into an axis after a missing value.
    xRight = axis(segment).x;
    xLeft = xRight - 15.0;
    yLeft = yRight;
  } else {
    // Stub leaving the last axis, or an axis before a missing value.
    xLeft = axis(segment - 1).x;
    xRight = xLeft + 15.0;
    yRight = yLeft;
  }

  int point = gl_VertexID / 2;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  float t = float(point) / float(u_samples - 1);
  float u = 1.0 - t;
  float handle = ${SPLINE_HANDLE.toFixed(6)} * (xRight - xLeft);
  vec2 p0 = vec2(xLeft, yLeft);
  vec2 p1 = vec2(xLeft + handle, yLeft + handle * slopeLeft);
  vec2 p2 = vec2(xRight - handle, yRight - handle * slopeRight);
  vec2 p3 = vec2(xRight, yRight);
  vec2 position = u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
  vec2 tangent = 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
  // Device pixels from here on, so the line width does not depend on the pixel ratio.
  position *= u_deviceScale;
  tangent *= u_deviceScale;
  vec2 direction = dot(tangent, tangent) > 1e-12 ? normalize(tangent) : vec2(1.0, 0.0);
  float extent = u_halfWidth + 1.0;
  position += vec2(-direction.y, direction.x) * side * extent;
  gl_Position = vec4(
    position.x / u_viewport.x * 2.0 - 1.0,
    1.0 - position.y / u_viewport.y * 2.0,
    0.0,
    1.0
  );
  uint bin = texelFetch(u_bins, at(row), 0).r;
  v_rgb = texelFetch(u_palette, at(int(bin)), 0).rgb;
  v_selected = selected ? 1.0 : 0.0;
  v_across = side * extent;
}
`;

/** Coverage of a device pixel `v_across` from the center of a line `2 * u_halfWidth` wide. */
const COVERAGE = `
uniform float u_halfWidth;
in float v_across;
float coverage() {
  return clamp(u_halfWidth + 0.5 - abs(v_across), 0.0, 1.0);
}
`;

/** Accumulates line density: selected colors in target 0, deselected counts in target 1. */
const DENSITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${COVERAGE}
in vec3 v_rgb;
in float v_selected;
layout(location = 0) out vec4 selected;
layout(location = 1) out vec4 context;
void main() {
  float covered = coverage();
  selected = vec4(v_rgb, 1.0) * v_selected * covered;
  context = vec4(1.0 - v_selected) * covered;
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
 * how many lines cross a pixel, relative to a reference density, and the color
 * is the average color of those lines. The selection is composited over the
 * faint deselected layer.
 */
const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_selectedDensity;
uniform sampler2D u_contextDensity;
uniform float u_selectedReference;
uniform float u_contextReference;
uniform vec3 u_contextColor;
uniform float u_contextAlpha;
out vec4 color;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 selected = texelFetch(u_selectedDensity, pixel, 0);
  float context = texelFetch(u_contextDensity, pixel, 0).r;
  float selectedAlpha = clamp(log(1.0 + selected.a) / log(1.0 + u_selectedReference), 0.0, 1.0);
  float contextAlpha =
    u_contextAlpha * clamp(log(1.0 + context) / log(1.0 + u_contextReference), 0.0, 1.0);
  vec3 selectedColor = selected.a > 0.0 ? selected.rgb / selected.a : vec3(0.0);
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
const SELECTED_DENSITY_UNIT = 6;
const CONTEXT_DENSITY_UNIT = 7;

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

/** Float render targets the line pass accumulates densities into. */
interface DensityTargets {
  framebuffer: WebGLFramebuffer;
  selected: WebGLTexture;
  context: WebGLTexture;
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
  private readonly densityPrograms: { lines: Program; composite: Program } | null;
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
  private uploadedOrder: Uint32Array | null = null;
  private uploadedBins: Uint32Array | null = null;
  private uploadedPalette: ReadonlyArray<RGB> | null = null;
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
    this.densityPrograms =
      gl.getExtension("EXT_color_buffer_float") === null
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private bind(name: SamplerName): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + UNITS[name]);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[name]);
  }

  /** Starts over for a new set of rows: every per-row texture is re-uploaded on demand. */
  setRows(rowCount: number, order: Uint32Array): void {
    if (rowCount === this.rowCount && order === this.uploadedOrder) {
      return;
    }
    const gl = this.gl;
    this.rowCount = rowCount;
    this.layout = textureLayout(rowCount, this.maxTextureSize);
    this.slots = new Map();
    this.slotCapacity = 0;
    this.uploadedBins = null;
    this.uploadedSelection = null;
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

  setColors(bins: Uint32Array, palette: ReadonlyArray<RGB>): void {
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
      gl.deleteTexture(this.density.selected);
      gl.deleteTexture(this.density.context);
    }
    const target = (): WebGLTexture => {
      const texture = gl.createTexture();
      if (texture === null) {
        throw new Error("Could not create a WebGL texture");
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
      return texture;
    };
    const selected = target();
    const context = target();
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) {
      throw new Error("Could not create a WebGL framebuffer");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selected, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, context, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.density = { framebuffer, selected, context, width, height };
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
    gl.uniform1i(program.uniform("u_samples"), samples);
    gl.uniform1i(program.uniform("u_curved"), frame.curved ? 1 : 0);
    gl.uniform2f(
      program.uniform("u_deviceScale"),
      gl.drawingBufferWidth / Math.max(1, frame.width),
      gl.drawingBufferHeight / Math.max(1, frame.height),
    );
    gl.uniform2f(program.uniform("u_viewport"), gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(program.uniform("u_halfWidth"), (frame.lineWidth * frame.pixelRatio) / 2);
    return samples;
  }

  private drawLines(frame: LineFrame, samples: number): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vertexArray);
    gl.drawArraysInstanced(
      gl.TRIANGLE_STRIP,
      0,
      2 * samples,
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
    const { lines, composite } = this.densityPrograms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.blendFunc(gl.ONE, gl.ONE);
    const samples = this.prepareLines(lines, frame);
    gl.uniform1i(lines.uniform("u_keep"), DRAW_ALL);
    this.drawLines(frame, samples);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0 + SELECTED_DENSITY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, targets.selected);
    gl.activeTexture(gl.TEXTURE0 + CONTEXT_DENSITY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, targets.context);
    gl.uniform1i(composite.uniform("u_selectedDensity"), SELECTED_DENSITY_UNIT);
    gl.uniform1i(composite.uniform("u_contextDensity"), CONTEXT_DENSITY_UNIT);
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
    gl.activeTexture(gl.TEXTURE0 + SELECTED_DENSITY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0 + CONTEXT_DENSITY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
