import type { ExactReply, ExactRequest } from "./exact_types";
import type { FinishedFrame, LineColors, LineFrame } from "./webgl";
import { WorkerFrameCache } from "./worker_payload";

interface PendingFrame {
  id: number;
  frame: LineFrame;
  colors: LineColors;
  selection: Uint8Array;
  order: Uint32Array;
  fallbackOrder: () => Uint32Array;
}

/** One worker owns the GPU work; only a completed, current image reaches the page. */
export class ExactRenderer {
  private worker: Worker | null = null;
  private density: boolean | null = null;
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

  draw(
    frame: LineFrame,
    colors: LineColors,
    selection: Uint8Array,
    order: Uint32Array,
    fallbackOrder: () => Uint32Array,
  ): void {
    if (this.disposed) throw new Error("Cannot draw with a disposed exact renderer");
    if (this.failure !== null) throw this.failure;
    if (
      selection.length !== order.length ||
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
      selection: selection.slice(),
      order,
      fallbackOrder,
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
        this.dispatchPending();
        return;
      }
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
    const { id, frame, colors, selection, order, fallbackOrder } = pending;
    const transfer: Transferable[] = [selection.buffer];
    const request: ExactRequest = {
      ...frame,
      id,
      ...this.frameCache.encode(frame.axes, colors, transfer),
      selection,
    };
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
    this.worker?.terminate();
    this.worker = null;
  }
}
