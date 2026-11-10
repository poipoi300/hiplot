import { describe, expect, mock, test } from "bun:test";
import { ContinuousWebGLReconstruction } from "./continuous_reconstruction_gl";
import type { ContinuousHistogram } from "./continuous_types";

type Upload = {
  unit: number;
  texture: WebGLTexture | null;
  internalFormat: number;
  width: number;
  height: number;
  format: number;
  type: number;
  data: Float32Array | null;
};

type Failure = {
  program?: boolean;
  shader?: number;
  compile?: boolean;
  link?: boolean;
  texture?: number;
  framebuffer?: boolean;
  uniform?: string;
};

// Only the binding/resource protocol is simulated; no shader is executed here.
function mockGL(failure: Failure = {}) {
  const textures: WebGLTexture[] = [];
  const shaders: WebGLShader[] = [];
  const program: WebGLProgram = {};
  const framebuffer: WebGLFramebuffer = {};
  const bindings = new Map<number, WebGLTexture | null>();
  const uploads: Upload[] = [];
  let unit = 0;
  let textureAttempts = 0;
  let shaderAttempts = 0;
  const state = {
    lost: false,
    error: 0,
    framebufferStatus: 0x8cd5,
    maximumTexture: 4096,
  };
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    MAX_TEXTURE_SIZE: 0x0d33,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    RG32F: 0x8230,
    RG: 0x8227,
    FLOAT: 0x1406,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_ATTACHMENT0: 0x8ce0,
    TRIANGLES: 0x0004,
    BLEND: 0x0be2,
    DITHER: 0x0bd0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    NO_ERROR: 0,
    createProgram: mock(() => (failure.program ? null : program)),
    createShader: mock((_type: number): WebGLShader | null => {
      shaderAttempts++;
      if (shaderAttempts === failure.shader) return null;
      const shader: WebGLShader = {};
      shaders.push(shader);
      return shader;
    }),
    shaderSource: mock((_shader: WebGLShader, _source: string) => {}),
    compileShader: mock((_shader: WebGLShader) => {}),
    getShaderParameter: mock((_shader: WebGLShader, _parameter: number) => !failure.compile),
    getShaderInfoLog: mock((_shader: WebGLShader) => "compile diagnostic"),
    attachShader: mock((_program: WebGLProgram, _shader: WebGLShader) => {}),
    linkProgram: mock((_program: WebGLProgram) => {}),
    getProgramParameter: mock((_program: WebGLProgram, _parameter: number) => !failure.link),
    getProgramInfoLog: mock((_program: WebGLProgram) => "link diagnostic"),
    deleteShader: mock((_shader: WebGLShader) => {}),
    deleteProgram: mock((_program: WebGLProgram) => {}),
    createTexture: mock((): WebGLTexture | null => {
      textureAttempts++;
      if (textureAttempts === failure.texture) return null;
      const texture: WebGLTexture = {};
      textures.push(texture);
      return texture;
    }),
    deleteTexture: mock((_texture: WebGLTexture | null) => {}),
    createFramebuffer: mock(() => (failure.framebuffer ? null : framebuffer)),
    deleteFramebuffer: mock((_framebuffer: WebGLFramebuffer | null) => {}),
    getUniformLocation: mock((_program: WebGLProgram, name: string) => {
      if (name === failure.uniform) return null;
      const location: WebGLUniformLocation = {};
      return location;
    }),
    uniform1i: mock((_location: WebGLUniformLocation, _value: number) => {}),
    uniform1f: mock((_location: WebGLUniformLocation, _value: number) => {}),
    isContextLost: mock(() => state.lost),
    getParameter: mock((_parameter: number) => state.maximumTexture),
    useProgram: mock((_program: WebGLProgram) => {}),
    disable: mock((_capability: number) => {}),
    activeTexture: mock((texture: number) => {
      unit = texture - gl.TEXTURE0;
    }),
    bindTexture: mock((_target: number, texture: WebGLTexture | null) => {
      bindings.set(unit, texture);
    }),
    texImage2D: mock(
      (
        _target: number,
        _level: number,
        internalFormat: number,
        width: number,
        height: number,
        _border: number,
        format: number,
        type: number,
        data: Float32Array | null,
      ) => {
        uploads.push({
          unit,
          texture: bindings.get(unit) ?? null,
          internalFormat,
          width,
          height,
          format,
          type,
          data: data?.slice() ?? null,
        });
      },
    ),
    texParameteri: mock((_target: number, _parameter: number, _value: number) => {}),
    bindFramebuffer: mock((_target: number, _framebuffer: WebGLFramebuffer) => {}),
    framebufferTexture2D: mock(
      (_target: number, _attachment: number, _textureTarget: number, _texture: WebGLTexture) => {},
    ),
    drawBuffers: mock((_buffers: number[]) => {}),
    readBuffer: mock((_buffer: number) => {}),
    checkFramebufferStatus: mock((_target: number) => state.framebufferStatus),
    viewport: mock((_x: number, _y: number, _width: number, _height: number) => {}),
    drawArrays: mock((_mode: number, _first: number, _count: number) => {}),
    readPixels: mock(
      (
        _x: number,
        _y: number,
        _width: number,
        _height: number,
        _format: number,
        _type: number,
        pixels: Uint8Array,
      ) => {
        pixels.set([11, 22, 33, 44]);
      },
    ),
    getError: mock(() => state.error),
  };
  // The intentionally narrow context implements exactly the methods used by this pass.
  const context = gl as unknown as WebGL2RenderingContext;
  return { gl, context, state, textures, shaders, program, framebuffer, bindings, uploads };
}

function histogram(): ContinuousHistogram {
  const bins = 5;
  const size = (bins + 1) ** 2;
  const selected = new Uint32Array(size);
  const context = new Uint32Array(size);
  selected[4] = 1;
  context[4 * (bins + 1)] = 1;
  return {
    bins,
    selected,
    context,
    occupied: new Uint32Array([4, 4 * (bins + 1)]),
    color0: new Float64Array(size),
    color1: new Float64Array(size),
    color2: new Float64Array(size),
    minimum: new Uint32Array(size),
    maximum: new Uint32Array(size),
    revision: 1,
  };
}

function render(pass: ContinuousWebGLReconstruction, counts = histogram()) {
  return pass.render({}, {}, counts, { height: 4, curved: false }, 4, 2);
}

describe("continuous reconstruction GL binding and lifecycle", () => {
  test("one output draw and readback use distinct sampler and output texture units", () => {
    const fixture = mockGL();
    const { gl, context, textures, bindings, uploads, framebuffer } = fixture;
    const pass = new ContinuousWebGLReconstruction(context);
    const selected: WebGLTexture = {};
    const background: WebGLTexture = {};
    try {
      const result = pass.render(
        selected,
        background,
        histogram(),
        { height: 3.25, curved: false },
        3.2,
        2,
      );
      expect(result.width).toBe(4);
      expect(result.height).toBe(4);
      expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
      expect(result.pixels.length).toBe(64);
      expect(Array.from(result.pixels.slice(0, 4))).toEqual([11, 22, 33, 44]);
      expect(bindings.get(0)).toBe(selected);
      expect(bindings.get(1)).toBe(background);
      expect(bindings.get(2)).toBe(textures[0]);
      expect(bindings.get(3)).toBe(textures[1]);
      expect(uploads.map(({ unit, texture }) => [unit, texture])).toEqual([
        [2, textures[0]],
        [3, textures[1]],
      ]);
      expect(uploads[1]).toMatchObject({
        internalFormat: gl.RGBA8,
        width: 4,
        height: 4,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        data: null,
      });
      expect(gl.bindFramebuffer).toHaveBeenCalledWith(gl.FRAMEBUFFER, framebuffer);
      expect(gl.framebufferTexture2D).toHaveBeenCalledWith(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        textures[1],
        0,
      );
      expect(gl.drawBuffers).toHaveBeenCalledWith([gl.COLOR_ATTACHMENT0]);
      expect(gl.readBuffer).toHaveBeenCalledWith(gl.COLOR_ATTACHMENT0);
      expect(gl.disable.mock.calls).toEqual([[gl.BLEND], [gl.DITHER]]);
      expect(gl.viewport).toHaveBeenCalledWith(0, 0, 4, 4);
      expect(gl.drawArrays.mock.calls).toEqual([[gl.TRIANGLES, 0, 3]]);
      expect(gl.readPixels).toHaveBeenCalledTimes(1);
      expect(gl.readPixels.mock.calls[0].slice(0, 6)).toEqual([
        0,
        0,
        4,
        4,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
      ]);
      expect(gl.readPixels.mock.calls[0][6].buffer).toBe(result.pixels.buffer);
      expect(gl.texParameteri.mock.calls).toEqual(
        [0, 1].flatMap(() => [
          [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST],
          [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST],
          [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
          [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        ]),
      );
    } finally {
      pass.dispose();
    }
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
    expect(gl.deleteTexture.mock.calls[0][0]).toBe(textures[0]);
    expect(gl.deleteTexture.mock.calls[1][0]).toBe(textures[1]);
    for (const [deleted] of gl.deleteTexture.mock.calls) {
      expect(deleted).not.toBe(selected);
      expect(deleted).not.toBe(background);
    }
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteFramebuffer.mock.calls[0][0]).toBe(framebuffer);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram.mock.calls[0][0]).toBe(fixture.program);
  });

  test("guides pack source then destination columns with selected before context", () => {
    const { context, uploads, gl } = mockGL();
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      render(pass);
      expect(uploads[0]).toMatchObject({
        unit: 2,
        internalFormat: gl.RG32F,
        width: 4,
        height: 4,
        format: gl.RG,
        type: gl.FLOAT,
      });
      expect(Array.from(uploads[0].data ?? [])).toEqual([
        1, 1, 3, 3, 0, 0, 0, 0, 0.5, 0.5, 1.5, 1.5, 2.5, 2.5, 3.5, 3.5, 3, 3, 1, 1, 0, 0, 0, 0, 3.5,
        3.5, 2.5, 2.5, 1.5, 1.5, 0.5, 0.5,
      ]);
      const counts = histogram();
      counts.selected.fill(0);
      counts.context.fill(0);
      render(pass, counts);
      expect(Array.from(uploads[2].data ?? [])).toEqual([
        1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 1,
        -1, 1, -1, 1, -1,
      ]);
    } finally {
      pass.dispose();
    }
  });

  test("draft guides retain the full image texture capacity", () => {
    const { context, state, uploads } = mockGL();
    state.maximumTexture = 8;
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      const image = pass.render({}, {}, histogram(), { height: 4, curved: false }, 8, 2);
      expect([image.width, image.height]).toEqual([8, 4]);
      expect(uploads[0]).toMatchObject({ width: 8, height: 4 });
      expect(uploads[1]).toMatchObject({ width: 8, height: 4 });
    } finally {
      pass.dispose();
    }
  });

  test("repeated renders refresh both layers, dimensions and uniforms without new resources", () => {
    const { gl, context, uploads, textures, bindings } = mockGL();
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      render(pass);
      const counts = histogram();
      counts.selected.fill(0);
      const selected: WebGLTexture = {};
      const background: WebGLTexture = {};
      const second = pass.render(
        selected,
        background,
        counts,
        { height: 6.5, curved: true },
        2.2,
        1,
      );
      expect([second.width, second.height]).toEqual([3, 7]);
      expect(bindings.get(0)).toBe(selected);
      expect(bindings.get(1)).toBe(background);
      expect(uploads[2].width).toBe(3);
      expect(Array.from(uploads[2].data ?? [])).toEqual([
        1,
        -1,
        0,
        0,
        0,
        0,
        1,
        -1,
        1,
        -1,
        1,
        -1,
        3.25,
        3.25,
        0,
        0,
        0,
        0,
        Math.fround((6.5 * 25) / 27),
        Math.fround((6.5 * 25) / 27),
        3.25,
        3.25,
        Math.fround((6.5 * 2) / 27),
        Math.fround((6.5 * 2) / 27),
      ]);
      expect(uploads[3]).toMatchObject({ width: 3, height: 7, texture: textures[1] });
      expect(gl.uniform1i.mock.calls.map(([, value]) => value)).toEqual([
        0, 1, 2, 2, 4, 4, 0, 1, 2, 1, 3, 7,
      ]);
      expect(gl.uniform1f.mock.calls.map(([, value]) => value)).toEqual([4, 6.5]);
      expect(gl.getUniformLocation.mock.calls.map(([, name]) => name)).toEqual([
        "u_selected",
        "u_context",
        "u_guides",
        "u_sourceWidth",
        "u_width",
        "u_rows",
        "u_height",
      ]);
      expect(gl.createTexture).toHaveBeenCalledTimes(2);
      expect(gl.createProgram).toHaveBeenCalledTimes(1);
      expect(gl.createFramebuffer).toHaveBeenCalledTimes(1);
      expect(gl.drawArrays).toHaveBeenCalledTimes(2);
      expect(gl.readPixels).toHaveBeenCalledTimes(2);
      expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 3, 7);
    } finally {
      pass.dispose();
    }
  });

  test("incomplete framebuffer fails before drawing or reading and remains disposable", () => {
    const { gl, context, state, textures } = mockGL();
    const pass = new ContinuousWebGLReconstruction(context);
    state.framebufferStatus = 0x8cd6;
    try {
      expect(() => render(pass)).toThrow("Incomplete continuous reconstruction framebuffer");
      expect(gl.drawArrays).not.toHaveBeenCalled();
      expect(gl.readPixels).not.toHaveBeenCalled();
    } finally {
      pass.dispose();
    }
    expect(gl.deleteTexture.mock.calls).toEqual(textures.map((texture) => [texture]));
  });

  test("context loss fails before uploads and GL errors propagate after readback", () => {
    const { gl, context, state } = mockGL();
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      state.lost = true;
      expect(() => render(pass)).toThrow("Continuous reconstruction WebGL context lost");
      expect(gl.texImage2D).not.toHaveBeenCalled();
      expect(gl.drawArrays).not.toHaveBeenCalled();
      state.lost = false;
      state.error = 0x0502;
      expect(() => render(pass)).toThrow("Continuous reconstruction WebGL error 1282");
      expect(gl.readPixels).toHaveBeenCalledTimes(1);
    } finally {
      pass.dispose();
    }
  });

  test("invalid dimensions and texture capacity fail before uploads", () => {
    const { gl, context, state } = mockGL();
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      for (const [gap, sourceWidth] of [
        [0, 2],
        [Infinity, 2],
        [4, 0],
        [4, 1.5],
      ]) {
        expect(() =>
          pass.render({}, {}, histogram(), { height: 4, curved: false }, gap, sourceWidth),
        ).toThrow("Invalid continuous reconstruction width");
      }
      for (const height of [-1, Infinity, Number.NaN]) {
        expect(() => pass.render({}, {}, histogram(), { height, curved: false }, 4, 2)).toThrow(
          "Invalid continuous reconstruction height",
        );
      }
      state.maximumTexture = 3;
      expect(() => render(pass)).toThrow(
        "Continuous reconstruction image exceeds WebGL texture capacity",
      );
      expect(gl.texImage2D).not.toHaveBeenCalled();
      expect(gl.drawArrays).not.toHaveBeenCalled();
      expect(gl.readPixels).not.toHaveBeenCalled();
    } finally {
      pass.dispose();
    }
  });

  test("missing uniforms propagate without drawing and owned resources remain disposable", () => {
    const { gl, context, textures } = mockGL({ uniform: "u_width" });
    const pass = new ContinuousWebGLReconstruction(context);
    try {
      expect(() => render(pass)).toThrow("Missing continuous reconstruction uniform width");
      expect(gl.drawArrays).not.toHaveBeenCalled();
      expect(gl.readPixels).not.toHaveBeenCalled();
    } finally {
      pass.dispose();
    }
    expect(gl.deleteTexture.mock.calls).toEqual(textures.map((texture) => [texture]));
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  const allocationFailures: readonly [string, Failure, string][] = [
    ["program", { program: true }, "Cannot allocate continuous reconstruction program"],
    ["first shader", { shader: 1 }, "Cannot allocate continuous reconstruction shader"],
    ["second shader", { shader: 2 }, "Cannot allocate continuous reconstruction shader"],
    ["compile", { compile: true }, "Continuous reconstruction shader: compile diagnostic"],
    ["link", { link: true }, "Continuous reconstruction link: link diagnostic"],
    ["first texture", { texture: 1 }, "Cannot allocate continuous reconstruction texture"],
    ["second texture", { texture: 2 }, "Cannot allocate continuous reconstruction texture"],
    ["framebuffer", { framebuffer: true }, "Cannot allocate continuous reconstruction framebuffer"],
  ];
  for (const [name, failure, message] of allocationFailures) {
    test(`${name} failure propagates and releases every previously allocated resource`, () => {
      const { gl, context, textures, shaders, program } = mockGL(failure);
      expect(() => new ContinuousWebGLReconstruction(context)).toThrow(message);
      expect(gl.deleteTexture.mock.calls).toEqual(textures.map((texture) => [texture]));
      expect(gl.deleteShader.mock.calls).toEqual(shaders.map((shader) => [shader]));
      expect(gl.deleteProgram.mock.calls).toEqual(failure.program ? [] : [[program]]);
      expect(gl.deleteFramebuffer.mock.calls).toEqual(
        failure.texture || failure.framebuffer ? [[null]] : [],
      );
    });
  }
});
