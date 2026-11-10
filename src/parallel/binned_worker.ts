import type { BinnedImage, BinnedRequest } from "./binned";
import { BinnedPreview, PREVIEW_SCALE } from "./binned_preview";
import type { LineColors, LineFrame } from "./webgl";

interface PendingFrame {
  id: number;
  frame: LineFrame;
  colors: LineColors;
  selection: Uint8Array;
  rowWeight: number;
  stubWidth: number;
}

/** One worker job in flight, with only the most recent requested frame retained. */
class BinnedChannel {
  private worker: Worker | null = null;
  private readonly columnIds = new WeakMap<Float32Array, number>();
  private sentColumns = new Set<number>();
  private nextColumnId = 0;
  private nextFrameId = 0;
  private running = false;
  private pending: PendingFrame | null = null;
  private disposed = false;
  private failure: Error | null = null;
  private colors: LineColors | null = null;
  private selection: Uint8Array | null = null;

  constructor(private readonly onImage: (image: BinnedImage) => void) {}

  private connect(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; image?: BinnedImage; error?: string }>) => {
      if (this.disposed) return;
      if (data.error !== undefined) {
        this.fail(new Error(`Binned renderer: ${data.error}`));
        return;
      }
      if (this.pending !== null) {
        const pending = this.pending;
        this.pending = null;
        this.dispatch(pending);
        return;
      }
      if (data.id !== this.nextFrameId || data.image === undefined) {
        this.fail(new Error("Binned worker returned an unexpected frame"));
        return;
      }
      // Presentation finishes before observers see idle, including a draw requested by the callback.
      try {
        this.onImage(data.image);
      } finally {
        this.running = false;
        if (this.pending !== null && !this.disposed) {
          const pending = this.pending;
          this.pending = null;
          this.dispatch(pending);
        }
      }
    };
    worker.onerror = (event) => this.fail(new Error(`Binned worker failed: ${event.message}`));
    worker.onmessageerror = () =>
      this.fail(new Error("Binned worker returned an unreadable image"));
  }

  get busy(): boolean {
    return this.running || this.pending !== null;
  }

  draw(
    frame: LineFrame,
    colors: LineColors,
    selection: Uint8Array,
    rowWeight = 1,
    stubWidth = 15,
  ): void {
    if (this.disposed) throw new Error("Cannot draw with a disposed binned renderer");
    if (this.failure !== null) throw this.failure;
    const pending = { id: ++this.nextFrameId, frame, colors, selection, rowWeight, stubWidth };
    if (this.worker === null) {
      this.pending = pending;
      if (!this.running) {
        this.running = true;
        // Deferring the Vite-only module also keeps ordinary DOM/unit imports usable without a bundler.
        void import("./binned_entry?worker&inline")
          .then(({ default: InlineWorker }) => {
            if (this.disposed) return;
            this.connect(new InlineWorker());
            const next = this.pending;
            this.pending = null;
            if (next !== null) this.dispatch(next);
          })
          .catch((error: unknown) => {
            if (!this.disposed)
              this.fail(error instanceof Error ? error : new Error(String(error)));
          });
      }
      return;
    }
    if (this.running) {
      this.pending = pending;
      return;
    }
    this.dispatch(pending);
  }

  private dispatch({ id, frame, colors, selection, rowWeight, stubWidth }: PendingFrame): void {
    if (this.worker === null) throw new Error("Binned worker has not initialized");
    const transfer: Transferable[] = [];
    const columns: BinnedRequest["columns"][number][] = [];
    const activeColumns = new Set<number>();
    const axes = frame.axes.map((axis) => {
      let column = this.columnIds.get(axis.pixels);
      if (column === undefined) {
        column = ++this.nextColumnId;
        this.columnIds.set(axis.pixels, column);
      }
      activeColumns.add(column);
      if (!this.sentColumns.has(column)) {
        const pixels = axis.pixels.slice();
        columns.push({ id: column, pixels });
        transfer.push(pixels.buffer);
      }
      return { column, x: axis.x };
    });
    this.sentColumns = activeColumns;
    const request: BinnedRequest = {
      id,
      axes,
      columns,
      width: frame.width,
      height: frame.height,
      lineWidth: frame.lineWidth,
      contextColor: frame.contextColor,
      contextAlpha: frame.contextAlpha,
      colorMode: frame.colorMode,
      rowWeight,
      stubWidth,
    };
    if (
      this.colors === null ||
      this.colors.bins !== colors.bins ||
      this.colors.palette !== colors.palette ||
      this.colors.colorMapBins !== colors.colorMapBins
    ) {
      const bins = colors.bins.slice();
      request.colors = { ...colors, bins };
      transfer.push(bins.buffer);
      this.colors = colors;
    }
    let selectionChanged = this.selection === null || this.selection.length !== selection.length;
    if (!selectionChanged && this.selection !== null) {
      for (let row = 0; row < selection.length; ++row) {
        if (this.selection[row] !== selection[row]) {
          selectionChanged = true;
          break;
        }
      }
    }
    if (selectionChanged) {
      this.selection = selection.slice();
      request.selection = this.selection.slice();
      transfer.push(request.selection.buffer);
    }
    this.running = true;
    this.worker.postMessage(request, transfer);
  }

  private fail(error: Error): void {
    this.failure = error;
    this.running = false;
    this.pending = null;
    this.worker?.terminate();
    // Async worker failures must be visible to the host, not an indefinitely busy plot.
    setTimeout(() => {
      throw error;
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.pending = null;
    this.selection = null;
    this.colors = null;
    this.sentColumns.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Preview work never queues behind an all-row refinement in another worker. */
export class BinnedRenderer {
  private readonly preview = new BinnedPreview();
  private readonly full: BinnedChannel;
  private readonly quick: BinnedChannel;
  private active: BinnedChannel;

  constructor(onImage: (image: BinnedImage) => void) {
    this.full = new BinnedChannel((image) => {
      if (this.active === this.full) onImage(image);
    });
    this.quick = new BinnedChannel((image) => {
      if (this.active === this.quick) onImage(image);
    });
    this.active = this.full;
  }

  get busy(): boolean {
    return this.active.busy;
  }

  get previewing(): boolean {
    return this.active === this.quick;
  }

  draw(frame: LineFrame, colors: LineColors, selection: Uint8Array): void {
    if (!frame.draft) {
      this.active = this.full;
      this.full.draw(frame, colors, selection);
      return;
    }
    this.active = this.quick;
    const preview = this.preview.frame(frame, colors, selection);
    this.quick.draw(
      preview.frame,
      preview.colors,
      preview.selection,
      preview.rowWeight,
      15 * PREVIEW_SCALE,
    );
  }

  dispose(): void {
    this.full.dispose();
    this.quick.dispose();
  }
}
