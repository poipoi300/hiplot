import type { ExactReply, ExactRequest } from "./exact_types";
import type { FinishedFrame, LineColors, LineFocus, LineFrame } from "./webgl";
import { WorkerFrameCache } from "./worker_payload";

interface PendingFrame {
  id: number;
  frame: LineFrame;
  colors: LineColors;
  selection: Uint8Array;
  order: Uint32Array;
  fallbackOrder: () => Uint32Array;
  focus: LineFocus | null;
}

/** One worker owns the GPU work; only a completed, current image reaches the page. */
export class ExactRenderer {
  private worker: Worker | null = null;
  private density: boolean | null = null;
  private blocks = false;
  private starting = false;
  private running = false;
  private disposed = false;
  private failure: Error | null = null;
  private pending: PendingFrame | null = null;
  private activeId = 0;
  private nextId = 0;
  private readonly frameCache = new WorkerFrameCache();
  private order: Uint32Array | null = null;
  private drawOrder: Uint32Array | null = null;
  /**
   * A selection buffer the worker returned: brush moves send a selection per
   * frame, and reusing their buffers keeps a megabyte per move from piling
   * up as garbage for the worker's collector.
   */
  private spareSelection: Uint8Array | null = null;
  /** The focus rows the worker holds, by identity (see LineFocus). */
  private focusRows: Uint8Array | null = null;

  constructor(
    private readonly onImage: (bitmap: ImageBitmap, finished: FinishedFrame) => void,
    private readonly onUnavailable: () => void,
    private readonly createWorker: () => Promise<Worker> = async () => {
      const { default: InlineWorker } = await import("./exact_entry?worker&inline");
      return new InlineWorker();
    },
  ) {}

  get busy(): boolean {
    return this.starting || this.running || this.pending !== null;
  }

  /** Whether the started worker sums brush frames from retained blocks (see LineFocus). */
  get blockFrames(): boolean {
    return this.blocks;
  }

  draw(
    frame: LineFrame,
    colors: LineColors,
    selection: Uint8Array,
    order: Uint32Array,
    fallbackOrder: () => Uint32Array,
    focus: LineFocus | null = null,
  ): void {
    if (this.disposed) throw new Error("Cannot draw with a disposed exact renderer");
    if (this.failure !== null) throw this.failure;
    if (
      selection.length !== order.length ||
      (focus !== null && focus.rows.length !== order.length) ||
      colors.bins.length !== order.length ||
      frame.axes.some((axis) => axis.pixels.length !== order.length)
    ) {
      throw new Error("Exact renderer columns, colors and selection must identify the same rows");
    }
    this.pending = {
      id: ++this.nextId,
      frame: {
        ...frame,
        axes: frame.axes.map((axis) => ({ ...axis })),
        contextColor: { ...frame.contextColor },
      },
      colors,
      selection: this.selectionCopy(selection),
      order,
      fallbackOrder,
      focus,
    };
    if (this.worker !== null) {
      if (!this.running && this.density !== null) this.dispatchPending();
      return;
    }
    if (this.starting) return;
    this.starting = true;
    void this.createWorker()
      .then((worker) => {
        if (this.disposed) worker.terminate();
        else this.connect(worker);
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.fail(error);
      });
  }

  /** A copy of `selection` in a returned or superseded buffer when one fits. */
  private selectionCopy(selection: Uint8Array): Uint8Array {
    const spare =
      this.pending?.selection.length === selection.length
        ? this.pending.selection
        : this.spareSelection?.length === selection.length
          ? this.spareSelection
          : null;
    if (spare === this.spareSelection) this.spareSelection = null;
    if (spare === null) return selection.slice();
    spare.set(selection);
    return spare;
  }

  private connect(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<ExactReply>) => {
      if (this.disposed) {
        if (data.kind === "frame") data.bitmap.close();
        return;
      }
      if (data.kind === "error") {
        this.fail(new Error(data.message));
        return;
      }
      if (data.kind === "ready") {
        this.starting = false;
        if (data.density === null) {
          this.dispose();
          this.onUnavailable();
          return;
        }
        this.density = data.density;
        this.blocks = data.blocks;
        this.dispatchPending();
        return;
      }
      this.spareSelection = data.selection;
      if (data.id !== this.activeId || !this.running) {
        data.bitmap.close();
        this.fail(new Error("Exact worker returned an unexpected frame"));
        return;
      }
      try {
        if (this.pending === null) this.onImage(data.bitmap, data.finished);
      } finally {
        data.bitmap.close();
        this.running = false;
        if (!this.disposed) this.dispatchPending();
      }
    };
    worker.onerror = (event) => this.fail(new Error(`Exact worker failed: ${event.message}`));
    worker.onmessageerror = () => this.fail(new Error("Exact worker returned an unreadable image"));
  }

  private dispatchPending(): void {
    const pending = this.pending;
    if (pending === null || this.worker === null) return;
    this.pending = null;
    const { id, frame, colors, selection, order, fallbackOrder, focus } = pending;
    const transfer: Transferable[] = [selection.buffer];
    const request: ExactRequest = {
      ...frame,
      id,
      ...this.frameCache.encode(frame.axes, colors, transfer),
      selection,
      focus: focus === null ? null : { axis: focus.axis, active: focus.active },
    };
    if (focus !== null && request.focus !== null && focus.rows !== this.focusRows) {
      request.focus.rows = focus.rows.slice();
      transfer.push(request.focus.rows.buffer);
      this.focusRows = focus.rows;
    }
    const drawOrder = this.density ? order : fallbackOrder();
    if (this.order !== order) {
      request.order = order.slice();
      transfer.push(request.order.buffer);
      this.order = order;
    }
    if (this.drawOrder !== drawOrder) {
      request.drawOrder =
        drawOrder === order && request.order !== undefined ? request.order : drawOrder.slice();
      if (request.drawOrder !== request.order) transfer.push(request.drawOrder.buffer);
      this.drawOrder = drawOrder;
    }
    this.running = true;
    this.activeId = id;
    try {
      this.worker.postMessage(request, transfer);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.running = false;
    this.starting = false;
    this.pending = null;
    this.worker?.terminate();
    const failure = this.failure;
    setTimeout(() => {
      throw failure;
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.starting = false;
    this.pending = null;
    this.frameCache.clear();
    this.order = null;
    this.drawOrder = null;
    this.focusRows = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
