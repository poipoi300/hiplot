import type { LineColors, LineFrame } from "./webgl";

export const PREVIEW_ROWS = 128;
export const PREVIEW_SCALE = 0.5;

/** Stable stratified rows avoid aliasing a fixed stride with a source column's period. */
export function previewIndices(rows: number, limit = PREVIEW_ROWS): Uint32Array {
  const count = Math.min(rows, limit);
  return Uint32Array.from({ length: count }, (_, index) => {
    if (count === rows) return index;
    const fraction = (Math.imul(index + 1, 0x9e3779b1) >>> 0) / 0x100000000;
    return Math.floor(((index + fraction) * rows) / count);
  });
}

/** Owns only sampled copies; the original pixel/color buffers remain available for exact highlights. */
export class BinnedPreview {
  private rows = -1;
  private indices: Uint32Array = new Uint32Array();
  private columns = new WeakMap<Float32Array, Float32Array>();
  private colorBins = new WeakMap<Uint32Array, Uint32Array>();

  frame(frame: LineFrame, colors: LineColors, selection: Uint8Array) {
    if (
      colors.bins.length !== selection.length ||
      frame.axes.some(({ pixels }) => pixels.length !== selection.length)
    ) {
      throw new Error("Preview columns, selection and colors must identify the same rows");
    }
    if (selection.length !== this.rows) {
      this.rows = selection.length;
      this.indices = previewIndices(this.rows);
      this.columns = new WeakMap();
      this.colorBins = new WeakMap();
    }
    const axes = frame.axes.map(({ pixels, x }) => {
      let sampled = this.columns.get(pixels);
      if (sampled === undefined) {
        sampled = Float32Array.from(this.indices, (row) => pixels[row] * PREVIEW_SCALE);
        this.columns.set(pixels, sampled);
      }
      return { pixels: sampled, x: x * PREVIEW_SCALE };
    });
    let bins = this.colorBins.get(colors.bins);
    if (bins === undefined) {
      bins = Uint32Array.from(this.indices, (row) => colors.bins[row]);
      this.colorBins.set(colors.bins, bins);
    }
    const mask = Uint8Array.from(this.indices, (row) => selection[row]);
    return {
      frame: {
        ...frame,
        axes,
        width: frame.width * PREVIEW_SCALE,
        height: frame.height * PREVIEW_SCALE,
        lineWidth: frame.lineWidth * PREVIEW_SCALE,
      },
      colors: { ...colors, bins },
      selection: mask,
      rowWeight: this.indices.length > 0 ? this.rows / this.indices.length : 1,
    };
  }
}
