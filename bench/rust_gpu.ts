import type { ContinuousHistogram } from "../src/parallel/continuous_types";
import { HistogramTextures, packHistogramCPU } from "../src/parallel/histogram_upload";
import { RustKernels } from "../src/wasm/kernels";

/** Packing plus completed texture uploads; excludes shaders and image publication. */
export function profileHistogramUploads(repetitions = 21) {
  const gl = document.createElement("canvas").getContext("webgl2");
  const kernels = RustKernels.create();
  if (gl === null || kernels === null) throw new Error("GPU benchmark requires WebGL2 and WASM");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unavailable";
  const stride = 501;
  const cells = stride ** 2;
  const histogram: ContinuousHistogram = {
    bins: stride - 1,
    selected: new Uint32Array(cells).fill(2),
    context: new Uint32Array(cells).fill(1),
    color0: new Float64Array(cells).fill(128),
    color1: new Float64Array(cells).fill(1),
    color2: new Float64Array(cells).fill(65535),
    minimum: new Uint32Array(cells).fill(0),
    maximum: new Uint32Array(cells).fill(255),
    occupied: Uint32Array.from({ length: cells }, (_, cell) => cell),
    revision: 1,
  };
  const legacy = [gl.createTexture(), gl.createTexture()];
  if (legacy.some((texture) => texture === null))
    throw new Error("Cannot allocate baseline textures");
  const textures = new HistogramTextures(gl, 64 * 1024 * 1024, kernels);
  const cases = [];
  try {
    for (const extra of [false, true]) {
      for (const changes of ["one cell", "all cells"] as const) {
        const samples = { javascript: [] as number[], candidate: [] as number[] };
        textures.bind(histogram, extra);
        gl.finish();
        for (let rep = 0; rep <= repetitions; ++rep) {
          if (changes === "one cell") histogram.selected[Math.floor(cells / 2)]++;
          else for (let cell = 0; cell < cells; ++cell) histogram.selected[cell]++;
          histogram.revision++;
          // Alternate methods against the same revision, including one unrecorded warmup.
          for (const method of rep % 2 === 0
            ? (["javascript", "candidate"] as const)
            : (["candidate", "javascript"] as const)) {
            const start = performance.now();
            if (method === "candidate") textures.bind(histogram, extra);
            else {
              const packed = packHistogramCPU(histogram, extra);
              for (let unit = 0; unit < 2; ++unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, legacy[unit]);
                const width = unit === 0 || extra ? stride : 1;
                gl.texImage2D(
                  gl.TEXTURE_2D,
                  0,
                  gl.RGBA32F,
                  width,
                  width,
                  0,
                  gl.RGBA,
                  gl.FLOAT,
                  unit === 0 ? packed.counts : packed.extra,
                );
              }
            }
            gl.finish();
            if (rep > 0) samples[method].push(performance.now() - start);
          }
        }
        const median = (values: number[]) =>
          values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        cases.push({
          extra,
          changes,
          javascriptMs: median(samples.javascript),
          candidateMs: median(samples.candidate),
          fullUploadBytes: cells * 16 * (extra ? 2 : 1) + (extra ? 0 : 16),
          candidateUploadBytes: extra
            ? (changes === "one cell" ? stride : cells) * 32
            : cells * 16 + 16,
        });
      }
    }
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error("GPU upload benchmark reported a WebGL error");
    return { renderer, stride, repetitions, wasmMemoryBytes: kernels.memoryBytes, cases };
  } finally {
    textures.dispose();
    for (const texture of legacy) gl.deleteTexture(texture);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
