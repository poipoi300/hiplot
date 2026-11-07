/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { RGB } from "../lib/colors";
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
  /** Pixel size of the plot area. */
  width: number;
  height: number;
  alpha: number;
  /** Bezier curves between axes, or straight segments. */
  curved: boolean;
}

/** Vertices of one segment: a strip along the Bezier curve, or a straight line. */
const CURVE_VERTICES = 9;
const STRAIGHT_VERTICES = 2;

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
uniform int u_vertexCount;
uniform vec2 u_canvasSize;
uniform float u_alpha;

out vec4 v_color;

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

void main() {
  int segments = u_axisCount + 1;
  int line = gl_InstanceID / segments;
  int segment = gl_InstanceID - line * segments;
  int row = int(texelFetch(u_order, at(line), 0).r);
  bool selected = texelFetch(u_selected, at(row), 0).r > 0u;

  float yLeft = segment >= 1 ? pixelY(segment - 1, row) : ${MISSING_THRESHOLD * 10};
  float yRight = segment < u_axisCount ? pixelY(segment, row) : ${MISSING_THRESHOLD * 10};
  bool hasLeft = yLeft > ${MISSING_THRESHOLD};
  bool hasRight = yRight > ${MISSING_THRESHOLD};
  if (!selected || (!hasLeft && !hasRight)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    return;
  }
  float xLeft;
  float xRight;
  if (hasLeft && hasRight) {
    xLeft = axis(segment - 1).x;
    xRight = axis(segment).x;
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

  float t = float(gl_VertexID) / float(u_vertexCount - 1);
  vec2 p0 = vec2(xLeft, yLeft);
  vec2 p3 = vec2(xRight, yRight);
  vec2 position;
  if (u_vertexCount == 2) {
    position = mix(p0, p3, t);
  } else {
    vec2 p1 = vec2(xRight - 0.88 * (xRight - xLeft), yLeft);
    vec2 p2 = vec2(xRight - 0.12 * (xRight - xLeft), yRight);
    float u = 1.0 - t;
    position = u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
  }
  gl_Position = vec4(
    position.x / u_canvasSize.x * 2.0 - 1.0,
    1.0 - position.y / u_canvasSize.y * 2.0,
    0.0,
    1.0
  );
  uint bin = texelFetch(u_bins, at(row), 0).r;
  vec3 rgb = texelFetch(u_palette, at(int(bin)), 0).rgb;
  v_color = vec4(rgb * u_alpha, u_alpha);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 color;
void main() {
  color = v_color;
}
`;

const UNIFORMS = [
  "u_pixels",
  "u_axes",
  "u_order",
  "u_selected",
  "u_bins",
  "u_palette",
  "u_axisCount",
  "u_textureWidth",
  "u_rowsPerColumn",
  "u_vertexCount",
  "u_canvasSize",
  "u_alpha",
] as const;
type UniformName = (typeof UNIFORMS)[number];

/** Texture unit of each sampler. */
const UNITS = {
  u_pixels: 0,
  u_axes: 1,
  u_order: 2,
  u_selected: 3,
  u_bins: 4,
  u_palette: 5,
} as const;
type SamplerName = keyof typeof UNITS;

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

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (program === null) {
    throw new Error("Could not create a WebGL program");
  }
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
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
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
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
      antialias: true,
    });
    return gl === null ? null : new WebGLLineRenderer(gl);
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = link(gl);
    const uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
    for (const name of UNIFORMS) {
      uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    this.uniforms = uniforms as Record<UniformName, WebGLUniformLocation | null>;
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

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.program);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.rowCount === 0 || frame.axes.length === 0) {
      return;
    }
    for (const [name, unit] of Object.entries(UNITS)) {
      gl.uniform1i(this.uniforms[name as SamplerName], unit);
    }
    const vertexCount = frame.curved ? CURVE_VERTICES : STRAIGHT_VERTICES;
    gl.uniform1i(this.uniforms.u_axisCount, frame.axes.length);
    gl.uniform1i(this.uniforms.u_textureWidth, this.layout.width);
    gl.uniform1i(this.uniforms.u_rowsPerColumn, this.layout.rowsPerColumn);
    gl.uniform1i(this.uniforms.u_vertexCount, vertexCount);
    gl.uniform2f(this.uniforms.u_canvasSize, frame.width, frame.height);
    gl.uniform1f(this.uniforms.u_alpha, frame.alpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArraysInstanced(
      frame.curved ? gl.LINE_STRIP : gl.LINES,
      0,
      vertexCount,
      this.rowCount * segmentsPerLine(frame.axes.length),
    );
    gl.bindVertexArray(null);
  }
}
