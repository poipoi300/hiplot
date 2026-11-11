/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { RGB } from "../lib/colors";
import { linkProgram } from "../lib/webgl";

/**
 * Draws the 3D scatter with WebGL2: every row is one round, anti-aliased
 * point; the deselected rows first, faint, then the selection over them; the
 * edges of the data cube behind both. Positions, colors and selection flags
 * live in vertex buffers, so turning the camera is one uniform upload.
 */

const POINT_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 u_matrix;
uniform float u_pointSize;
uniform int u_keepSelected;
in vec3 a_position;
in vec4 a_color;
in float a_selected;
out vec4 v_color;
void main() {
  bool selected = a_selected > 0.5;
  bool missing = isnan(a_position.x) || isnan(a_position.y) || isnan(a_position.z);
  if (missing || selected != (u_keepSelected == 1)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_color = vec4(0.0);
    return;
  }
  gl_Position = u_matrix * vec4(a_position, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}
`;

const POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform float u_pointSize;
uniform vec4 u_context;
uniform int u_keepSelected;
in vec4 v_color;
out vec4 color;
void main() {
  // Distance from the center of the point sprite, in device pixels.
  float radius = u_pointSize / 2.0;
  float distance = length(gl_PointCoord - 0.5) * u_pointSize;
  float coverage = clamp(radius - distance, 0.0, 1.0);
  vec4 base = u_keepSelected == 1 ? v_color : u_context;
  color = vec4(base.rgb, base.a * coverage);
}
`;

const LINE_VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec3 a_position;
void main() {
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`;

const LINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 color;
void main() {
  color = u_color;
}
`;

/** The 12 edges of the [-1, 1]^3 cube, as line segments. */
function cubeEdges(): Float32Array {
  const corners = [-1, 1];
  const edges: number[] = [];
  for (const a of corners) {
    for (const b of corners) {
      edges.push(-1, a, b, 1, a, b);
      edges.push(a, -1, b, a, 1, b);
      edges.push(a, b, -1, a, b, 1);
    }
  }
  return new Float32Array(edges);
}

function buffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const created = gl.createBuffer();
  if (created === null) {
    throw new Error("Could not create a WebGL buffer");
  }
  return created;
}

function vertexArray(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const created = gl.createVertexArray();
  if (created === null) {
    throw new Error("Could not create a WebGL vertex array");
  }
  return created;
}

/** What one frame shows. */
export interface PointsFrame {
  matrix: Float32Array;
  /** Point diameter in device pixels. */
  pointSize: number;
  contextColor: RGB;
  contextAlpha: number;
  edgeColor: RGB;
}

const rgba = ({ r, g, b }: RGB, alpha: number): [number, number, number, number] => [
  r / 255,
  g / 255,
  b / 255,
  alpha,
];

export class PointsRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly points: WebGLProgram;
  private readonly lines: WebGLProgram;
  private readonly pointArray: WebGLVertexArrayObject;
  private readonly lineArray: WebGLVertexArrayObject;
  private readonly positions: WebGLBuffer;
  private readonly colors: WebGLBuffer;
  private readonly selection: WebGLBuffer;
  private count = 0;

  /** A renderer on `canvas`, or null when WebGL2 is unavailable. */
  static create(canvas: HTMLCanvasElement): PointsRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
    });
    return gl === null ? null : new PointsRenderer(gl);
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.points = linkProgram(gl, POINT_VERTEX_SHADER, POINT_FRAGMENT_SHADER, "WebGL points");
    this.lines = linkProgram(gl, LINE_VERTEX_SHADER, LINE_FRAGMENT_SHADER, "WebGL edges");
    this.positions = buffer(gl);
    this.colors = buffer(gl);
    this.selection = buffer(gl);
    this.pointArray = vertexArray(gl);
    gl.bindVertexArray(this.pointArray);
    const attribute = (
      name: string,
      source: WebGLBuffer,
      size: number,
      type: number,
      normalized: boolean,
    ) => {
      const location = gl.getAttribLocation(this.points, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, source);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, 0, 0);
    };
    attribute("a_position", this.positions, 3, gl.FLOAT, false);
    attribute("a_color", this.colors, 4, gl.UNSIGNED_BYTE, true);
    attribute("a_selected", this.selection, 1, gl.UNSIGNED_BYTE, false);
    this.lineArray = vertexArray(gl);
    gl.bindVertexArray(this.lineArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl));
    gl.bufferData(gl.ARRAY_BUFFER, cubeEdges(), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.lines, "a_position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Point positions (x, y, z per row, NaN where a value is missing) and RGBA colors. */
  setPoints(positions: Float32Array, colors: Uint8Array): void {
    const gl = this.gl;
    this.count = positions.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  }

  /** Per-row selection flags (1 = selected). */
  setSelection(selected: Uint8Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selection);
    gl.bufferData(gl.ARRAY_BUFFER, selected, gl.DYNAMIC_DRAW);
  }

  draw(frame: PointsFrame): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.lines);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lines, "u_matrix"), false, frame.matrix);
    gl.uniform4fv(gl.getUniformLocation(this.lines, "u_color"), rgba(frame.edgeColor, 0.7));
    gl.bindVertexArray(this.lineArray);
    gl.drawArrays(gl.LINES, 0, 24);

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(this.points);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.points, "u_matrix"), false, frame.matrix);
    gl.uniform1f(gl.getUniformLocation(this.points, "u_pointSize"), frame.pointSize);
    gl.uniform4fv(
      gl.getUniformLocation(this.points, "u_context"),
      rgba(frame.contextColor, frame.contextAlpha),
    );
    gl.bindVertexArray(this.pointArray);
    const keep = gl.getUniformLocation(this.points, "u_keepSelected");
    gl.uniform1i(keep, 0);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.uniform1i(keep, 1);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
