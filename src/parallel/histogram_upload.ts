import { type RustKernels, rustKernels } from "../wasm/kernels";
import { type ContinuousHistogram, EMPTY_COLOR_KEY } from "./continuous_types";

/** Reference and WebAssembly-capability fallback. */
export function packHistogramCPU(histogram: ContinuousHistogram, needsExtra: boolean) {
  const counts = new Float32Array((histogram.bins + 1) ** 2 * 4);
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
  return {
    counts,
    extra,
    dirtyRows: Uint32Array.from({ length: histogram.bins + 1 }, (_, row) => row),
  };
}

interface TextureEntry {
  counts: WebGLTexture;
  extra: WebGLTexture;
  slot: number | null;
  histogram: ContinuousHistogram | null;
  revision: number;
  needsExtra: boolean;
  reservedBytes: number;
}

/** Bounded per-pair textures, plus one scratch pair for overflow. */
export class HistogramTextures {
  private readonly cache = new Map<ContinuousHistogram, TextureEntry>();
  private scratch: TextureEntry | null = null;
  private bytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly budgetBytes = 64 * 1024 * 1024,
    private readonly kernels: RustKernels | null = rustKernels(),
  ) {}

  get cachedBytes(): number {
    return this.bytes;
  }

  prune(histograms: Iterable<ContinuousHistogram>): void {
    const active = new Set(histograms);
    for (const [histogram, entry] of this.cache) {
      if (active.has(histogram)) continue;
      this.release(entry);
      this.cache.delete(histogram);
      this.bytes -= entry.reservedBytes;
    }
    // A scratch entry must not keep a discarded experiment's column arrays alive.
    if (
      this.scratch !== null &&
      this.scratch.histogram !== null &&
      !active.has(this.scratch.histogram)
    ) {
      this.release(this.scratch);
      this.scratch = null;
    }
  }

  private create(reservedBytes: number): TextureEntry {
    const { gl } = this;
    const counts = gl.createTexture();
    if (counts === null) throw new Error("Cannot allocate histogram count texture");
    const extra = gl.createTexture();
    if (extra === null) {
      gl.deleteTexture(counts);
      throw new Error("Cannot allocate histogram extra texture");
    }
    for (const texture of [counts, extra]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return {
      counts,
      extra,
      slot: this.kernels?.createHistogram() ?? null,
      histogram: null,
      revision: -1,
      needsExtra: false,
      reservedBytes,
    };
  }

  private release(entry: TextureEntry): void {
    this.gl.deleteTexture(entry.counts);
    this.gl.deleteTexture(entry.extra);
    if (entry.slot !== null) this.kernels?.releaseHistogram(entry.slot);
  }

  bind(histogram: ContinuousHistogram, needsExtra: boolean): void {
    const stride = histogram.bins + 1;
    let entry = this.cache.get(histogram);
    if (entry === undefined) {
      // Reserve both RGBA32F layers so color-mode changes cannot exceed the budget.
      const reservedBytes = stride * stride * 4 * 4 * 2;
      if (this.bytes + reservedBytes <= this.budgetBytes) {
        entry = this.create(reservedBytes);
        this.cache.set(histogram, entry);
        this.bytes += reservedBytes;
      } else {
        this.scratch ??= this.create(0);
        entry = this.scratch;
      }
    }
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.counts);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, entry.extra);
    const reset = entry.histogram !== histogram || entry.needsExtra !== needsExtra;
    if (!reset && entry.revision === histogram.revision) return;
    const packed =
      // Copying numeric-mean planes into WASM costs more than their direct JS packing.
      needsExtra && this.kernels !== null && entry.slot !== null
        ? this.kernels.packHistogram(histogram, needsExtra, entry.slot, reset)
        : packHistogramCPU(histogram, needsExtra);
    const upload = (unit: number, data: Float32Array, width: number): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (reset || packed.dirtyRows.length === width) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, width, 0, gl.RGBA, gl.FLOAT, data);
        return;
      }
      // Merge adjacent dirty rows: sparse edits need few calls; dense edits become one upload.
      for (let index = 0; index < packed.dirtyRows.length; ++index) {
        const first = packed.dirtyRows[index];
        let last = first;
        while (index + 1 < packed.dirtyRows.length && packed.dirtyRows[index + 1] === last + 1)
          last = packed.dirtyRows[++index];
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          first,
          width,
          last - first + 1,
          gl.RGBA,
          gl.FLOAT,
          data.subarray(first * width * 4, (last + 1) * width * 4),
        );
      }
    };
    upload(0, packed.counts, stride);
    if (needsExtra) upload(1, packed.extra, stride);
    else if (reset) upload(1, packed.extra, 1);
    entry.histogram = histogram;
    entry.revision = histogram.revision;
    entry.needsExtra = needsExtra;
  }

  dispose(): void {
    for (const entry of this.cache.values()) this.release(entry);
    if (this.scratch !== null) this.release(this.scratch);
    this.cache.clear();
    this.scratch = null;
    this.bytes = 0;
  }
}
