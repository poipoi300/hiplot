import { expect, test } from "bun:test";
import { RustKernels } from "../wasm/kernels";
import { type ContinuousHistogram, EMPTY_COLOR_KEY } from "./continuous_types";
import { HistogramTextures, packHistogramCPU } from "./histogram_upload";

function histogram(): ContinuousHistogram {
  const bins = 3;
  const cells = (bins + 1) ** 2;
  return {
    bins,
    selected: Uint32Array.from({ length: cells }, (_, cell) => cell + 1),
    context: new Uint32Array(cells).fill(3),
    color0: Float64Array.from({ length: cells }, (_, cell) => cell * 65535),
    color1: new Float64Array(cells).fill(1),
    color2: new Float64Array(cells).fill(65535),
    minimum: new Uint32Array(cells).fill(EMPTY_COLOR_KEY),
    maximum: new Uint32Array(cells).fill(3),
    occupied: Uint32Array.of(1, 9, 15),
    revision: 1,
  };
}

function kernels(): RustKernels {
  const result = RustKernels.create();
  if (result === null) throw new Error("Tests require Rust/WASM");
  return result;
}

function context() {
  type Texture = WebGLTexture & { id: number };
  const bindings = new Map<number, Texture>();
  const images = new Map<Texture, Float32Array>();
  const calls: { full: boolean; width: number; rows: number; first: number; bytes: number }[] = [];
  const deleted: Texture[] = [];
  let active = 100;
  let id = 0;
  const texture = (): Texture => {
    const value = bindings.get(active);
    if (value === undefined) throw new Error("Missing bound test texture");
    return value;
  };
  const gl = {
    TEXTURE0: 100,
    TEXTURE1: 101,
    TEXTURE_2D: 2,
    TEXTURE_MIN_FILTER: 3,
    TEXTURE_MAG_FILTER: 4,
    TEXTURE_WRAP_S: 5,
    TEXTURE_WRAP_T: 6,
    NEAREST: 7,
    CLAMP_TO_EDGE: 8,
    RGBA32F: 9,
    RGBA: 10,
    FLOAT: 11,
    createTexture: () => ({ id: ++id }) as Texture,
    deleteTexture: (value: Texture) => deleted.push(value),
    activeTexture: (unit: number) => {
      active = unit;
    },
    bindTexture: (_target: number, value: Texture) => {
      bindings.set(active, value);
    },
    texParameteri: () => {},
    texImage2D: (
      _target: number,
      _level: number,
      _internal: number,
      width: number,
      height: number,
      _border: number,
      _format: number,
      _type: number,
      data: Float32Array,
    ) => {
      expect(data.length).toBe(width * height * 4);
      images.set(texture(), data.slice());
      calls.push({ full: true, width, rows: height, first: 0, bytes: data.byteLength });
    },
    texSubImage2D: (
      _target: number,
      _level: number,
      _left: number,
      top: number,
      width: number,
      height: number,
      _format: number,
      _type: number,
      data: Float32Array,
    ) => {
      const destination = images.get(texture());
      if (destination === undefined) throw new Error("Updating an unallocated test texture");
      expect(data.length).toBe(width * height * 4);
      destination.set(data, top * width * 4);
      calls.push({ full: false, width, rows: height, first: top, bytes: data.byteLength });
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    deleted,
    image: (unit: number) => images.get(bindings.get(100 + unit) as Texture),
  };
}

test("Rust packs identical float32 texture bytes and tracks only rows whose encoded values change", () => {
  const rust = kernels();
  const slot = rust.createHistogram();
  const input = histogram();
  try {
    for (const extra of [false, true, false, true]) {
      const actual = rust.packHistogram(input, extra, slot, true);
      const expected = packHistogramCPU(input, extra);
      expect(actual.counts).toEqual(expected.counts);
      expect(actual.extra).toEqual(expected.extra);
      expect(rust.packHistogram(input, extra, slot, false).dirtyRows.length).toBe(0);
    }
    input.selected[9]++;
    const changed = rust.packHistogram(input, true, slot, false);
    expect(Array.from(changed.dirtyRows)).toEqual([2]);
    input.color0[1] = 2 ** 28;
    rust.packHistogram(input, true, slot, false);
    input.color0[1]++;
    expect(rust.packHistogram(input, true, slot, false).dirtyRows.length).toBe(0);
    const replacement = histogram();
    replacement.occupied = Uint32Array.of(2);
    expect(rust.packHistogram(replacement, true, slot, true).counts).toEqual(
      packHistogramCPU(replacement, true).counts,
    );
  } finally {
    rust.releaseHistogram(slot);
  }
  expect(rust.createHistogram()).toBe(slot);
  rust.releaseHistogram(slot);
});

test("dense Rust packing preserves float32 rounding and checks grid dimensions before copying", () => {
  const rust = kernels();
  const slot = rust.createHistogram();
  const cells = 33 ** 2;
  const input: ContinuousHistogram = {
    bins: 32,
    selected: Uint32Array.from({ length: cells }, (_, cell) => [1, 16777217, 0xffffffff][cell % 3]),
    context: new Uint32Array(cells).fill(1),
    color0: Float64Array.from({ length: cells }, (_, cell) => cell * 65535),
    color1: new Float64Array(cells),
    color2: new Float64Array(cells).fill(0.7),
    minimum: new Uint32Array(cells).fill(EMPTY_COLOR_KEY),
    maximum: new Uint32Array(cells).fill(16777217),
    occupied: Uint32Array.from({ length: cells }, (_, cell) => cell),
    revision: 1,
  };
  try {
    const packed = rust.packHistogram(input, true, slot, true);
    const reference = packHistogramCPU(input, true);
    expect(packed.counts).toEqual(reference.counts);
    expect(packed.extra).toEqual(reference.extra);
    expect(() =>
      rust.packHistogram({ ...input, color0: new Float64Array(3) }, true, slot, true),
    ).toThrow("declared square grid");
  } finally {
    rust.releaseHistogram(slot);
  }
});

test("warm histogram textures upload only changed rows and retain exact texture contents", () => {
  const mock = context();
  const uploader = new HistogramTextures(mock.gl, 1024, kernels());
  const input = histogram();
  uploader.bind(input, true);
  expect(mock.calls.map((call) => call.full)).toEqual([true, true]);
  uploader.bind(input, true);
  expect(mock.calls.length).toBe(2);
  input.selected[9]++;
  input.context[9]--;
  input.minimum[9] = 1;
  input.revision++;
  uploader.bind(input, true);
  expect(mock.calls.slice(2).map(({ full, rows, first }) => ({ full, rows, first }))).toEqual([
    { full: false, rows: 1, first: 2 },
    { full: false, rows: 1, first: 2 },
  ]);
  expect(mock.image(0)).toEqual(packHistogramCPU(input, true).counts);
  expect(mock.image(1)).toEqual(packHistogramCPU(input, true).extra);
  uploader.bind(input, false);
  expect(mock.image(1)).toEqual(new Float32Array(4));
  uploader.bind(input, true);
  expect(mock.image(1)).toEqual(packHistogramCPU(input, true).extra);
  uploader.dispose();
  expect(mock.deleted.length).toBe(2);
  expect(uploader.cachedBytes).toBe(0);
});

test("histogram cache stays bounded and scratch reuse clears cells from the previous pair", () => {
  const mock = context();
  const uploader = new HistogramTextures(mock.gl, 512, kernels());
  const first = histogram();
  const second = histogram();
  second.occupied = Uint32Array.of(2);
  const third = histogram();
  third.occupied = Uint32Array.of(5);
  uploader.bind(first, true);
  uploader.bind(second, true);
  uploader.bind(third, true);
  expect(uploader.cachedBytes).toBe(512);
  expect(mock.image(0)).toEqual(packHistogramCPU(third, true).counts);
  uploader.prune([first]);
  expect(uploader.cachedBytes).toBe(512);
  expect(mock.deleted.length).toBe(2);
  uploader.prune([]);
  expect(mock.deleted.length).toBe(4);
  expect(uploader.cachedBytes).toBe(0);
  uploader.bind(second, false);
  expect(mock.image(0)).toEqual(packHistogramCPU(second, false).counts);
  uploader.dispose();
});

test("CSP fallback uploads complete JavaScript reference data without requiring WASM", () => {
  const mock = context();
  const uploader = new HistogramTextures(mock.gl, 0, null);
  const input = histogram();
  uploader.bind(input, true);
  input.selected[9]++;
  input.revision++;
  uploader.bind(input, true);
  expect(mock.image(0)).toEqual(packHistogramCPU(input, true).counts);
  expect(mock.calls.filter(({ full }) => !full).every(({ rows }) => rows === input.bins + 1)).toBe(
    true,
  );
  uploader.dispose();
});

test("histogram allocation failures report the failing resource and release partial textures", () => {
  const counts = context();
  Object.defineProperty(counts.gl, "createTexture", { value: () => null });
  expect(() => new HistogramTextures(counts.gl, 0, null).bind(histogram(), false)).toThrow(
    "count texture",
  );
  const extra = context();
  const create = extra.gl.createTexture.bind(extra.gl);
  let allocated = false;
  Object.defineProperty(extra.gl, "createTexture", {
    value: () => {
      if (allocated) return null;
      allocated = true;
      return create();
    },
  });
  expect(() => new HistogramTextures(extra.gl, 0, null).bind(histogram(), false)).toThrow(
    "extra texture",
  );
  expect(extra.deleted.length).toBe(1);
});
