import type { LineColors, LineFrame } from "./webgl";

interface WorkerPayload {
  axes: { column: number; x: number }[];
  columns: { id: number; pixels: Float32Array }[];
  colors?: LineColors;
}

/** Retains identities while transferring owned copies of newly needed frame data. */
export class WorkerFrameCache {
  private readonly columnIds = new WeakMap<Float32Array, number>();
  private nextColumnId = 0;
  private sentColumns = new Set<number>();
  private colors: LineColors | null = null;

  encode(axes: LineFrame["axes"], colors: LineColors, transfer: Transferable[]): WorkerPayload {
    const columns: WorkerPayload["columns"] = [];
    const activeColumns = new Set<number>();
    const encodedAxes = axes.map((axis) => {
      let column = this.columnIds.get(axis.pixels);
      if (column === undefined) {
        column = ++this.nextColumnId;
        this.columnIds.set(axis.pixels, column);
      }
      if (!activeColumns.has(column) && !this.sentColumns.has(column)) {
        const pixels = axis.pixels.slice();
        columns.push({ id: column, pixels });
        transfer.push(pixels.buffer);
      }
      activeColumns.add(column);
      return { column, x: axis.x };
    });
    this.sentColumns = activeColumns;
    const payload: WorkerPayload = { axes: encodedAxes, columns };
    if (
      this.colors === null ||
      this.colors.bins !== colors.bins ||
      this.colors.palette !== colors.palette ||
      this.colors.colorMapBins !== colors.colorMapBins
    ) {
      const bins = colors.bins.slice();
      payload.colors = { ...colors, bins, palette: colors.palette.map((rgb) => ({ ...rgb })) };
      transfer.push(bins.buffer);
      this.colors = colors;
    }
    return payload;
  }

  clear(): void {
    this.colors = null;
    this.sentColumns.clear();
  }
}
