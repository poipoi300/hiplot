import type { ContinuousMetrics, RenderMode, RenderReply, RenderRequest } from "./render_types";
import type { BrushVersion } from "./selection_delta";
import type { FinishedFrame, LineColors, LineFocus, LineFrame } from "./webgl";
import { WorkerFrameCache } from "./worker_payload";

/** A frame's selection: the page's flags, or a brush selection the worker holds (see attachBrush). */
export type FrameSelection = Uint8Array | BrushVersion;

interface PendingFrame {
  mode: RenderMode;
  frame: LineFrame;
  colors: LineColors;
  selection: FrameSelection;
  /** Exact frames: the shuffled row order, and the draw order without float targets. */
  order: Uint32Array | null;
  fallbackOrder: (() => Uint32Array) | null;
  focus: LineFocus | null;
}

/** A frame the worker finished: shown on its canvas, or a continuous image for the page to show. */
export interface WorkerFrame {
  mode: RenderMode;
  finished: FinishedFrame | null;
  continuous: ContinuousMetrics | null;
  pixels: Uint8ClampedArray | null;
}

/** Names the render worker in developer tools. */
export const RENDER_WORKER_NAME = "hiplot-render";

/** Selection buffers kept for reuse: one in flight each way covers a gesture. */
const SPARE_SELECTIONS = 2;

/**
 * The page's side of the render worker (see connectRenderWorker), which owns
 * the plot's canvas. Draw calls only post state: those of one task send the
 * last, as soon as the task ends, whether or not the worker is drawing, and
 * the worker draws the newest state it holds. Nothing on the page waits for a
 * frame.
 */
export class RenderWorker {
  private worker: Worker | null = null;
  private capabilities: Extract<RenderReply, { kind: "ready" }> | null = null;
  private starting = false;
  private disposed = false;
  private failure: Error | null = null;
  private pending: PendingFrame | null = null;
  private dispatchScheduled = false;
  private nextId = 0;
  private postedId = 0;
  private drawnId = 0;
  private readonly frameCache = new WorkerFrameCache();
  private order: Uint32Array | null = null;
  private drawOrder: Uint32Array | null = null;
  /** The focus rows the worker holds, by identity (see LineFocus). */
  private focusRows: Uint8Array | null = null;
  /** A copy of the selection the worker holds, to send only a changed one. */
  private sentSelection: Uint8Array | null = null;
  /**
   * Selection buffers the worker returned: brush moves send a selection per
   * frame, and reusing their buffers keeps a megabyte per move from piling
   * up as garbage.
   */
  private spareSelections: Uint8Array[] = [];
  /** The brush worker's port and link, until the worker starts and takes them. */
  private brushPort: { port: MessagePort; link: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrame: (frame: WorkerFrame) => void,
    /**
     * The page must draw: the worker failed, which is also rethrown, or it
     * cannot draw on the canvas and an exact frame was waiting for it.
     */
    private readonly onUnavailable: () => void,
    private readonly createWorker: () => Promise<Worker> = async () => {
      const { default: InlineWorker } = await import("./render_entry?worker&inline");
      return new InlineWorker({ name: RENDER_WORKER_NAME });
    },
  ) {}

  /** Whether the worker is starting, or a frame posted to it is not drawn yet. */
  get busy(): boolean {
    return this.starting || this.pending !== null || this.drawnId < this.postedId;
  }

  /** Whether the worker failed: it draws nothing more. */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** Whether the worker draws on the canvas; null until it started. */
  get presents(): boolean | null {
    return this.capabilities?.presents ?? null;
  }

  /** Whether the worker sums brush frames from retained blocks (see LineFocus). */
  get blockFrames(): boolean {
    return this.capabilities?.blocks ?? false;
  }

  drawExact(
    frame: LineFrame,
    colors: LineColors,
    selection: FrameSelection,
    order: Uint32Array,
    fallbackOrder: () => Uint32Array,
    focus: LineFocus | null = null,
  ): void {
    if (this.presents === false) throw new Error("The render worker cannot draw exact lines");
    if (
      order.length !== colors.bins.length ||
      (focus !== null && focus.rows.length !== order.length)
    ) {
      throw new Error("Exact frames' order, focus and selection must identify the same rows");
    }
    this.request("exact", frame, colors, selection, order, fallbackOrder, focus);
  }

  drawContinuous(frame: LineFrame, colors: LineColors, selection: FrameSelection): void {
    this.request("continuous", frame, colors, selection, null, null, null);
  }

  private request(
    mode: RenderMode,
    frame: LineFrame,
    colors: LineColors,
    selection: FrameSelection,
    order: Uint32Array | null,
    fallbackOrder: (() => Uint32Array) | null,
    focus: LineFocus | null,
  ): void {
    if (this.disposed) throw new Error("Cannot draw with a disposed render worker");
    if (this.failure !== null) throw this.failure;
    const rows = colors.bins.length;
    if (
      (selection instanceof Uint8Array && selection.length !== rows) ||
      frame.axes.some((axis) => axis.pixels.length !== rows)
    ) {
      throw new Error("Rendered columns, colors and selection must identify the same rows");
    }
    this.pending = {
      mode,
      frame: {
        ...frame,
        axes: frame.axes.map((axis) => ({ ...axis })),
        contextColor: { ...frame.contextColor },
      },
      colors,
      selection: selection instanceof Uint8Array ? this.selectionCopy(selection) : selection,
      order,
      fallbackOrder,
      focus,
    };
    if (this.capabilities === null) {
      this.start();
      return;
    }
    // Sent once the task ends: draws requested together, as by one React update, send only the last.
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => {
      this.dispatchScheduled = false;
      if (!this.disposed && this.failure === null) this.dispatchPending();
    });
  }

  /**
   * Starts the worker and gives it the canvas without a frame, so its script
   * and WebGL setup overlap the page's own before the first frame needs them.
   */
  start(): void {
    if (this.disposed) throw new Error("Cannot start a disposed render worker");
    if (this.worker !== null || this.starting) return;
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

  /**
   * Links the brush worker (see BrushSelection.attachRender): it sends its
   * selections to this worker, which frames then name by version.
   */
  attachBrush(port: MessagePort, link: number): void {
    if (this.disposed) throw new Error("Cannot link a disposed render worker");
    this.brushPort?.port.close();
    this.brushPort = { port, link };
    this.sendBrushPort();
  }

  private sendBrushPort(): void {
    const brush = this.brushPort;
    if (brush === null || this.worker === null || this.failure !== null) return;
    this.brushPort = null;
    try {
      this.worker.postMessage({ kind: "brush", ...brush }, [brush.port]);
    } catch (error) {
      this.fail(error);
    }
  }

  /** A copy of `selection` in a returned or superseded buffer when one fits. */
  private selectionCopy(selection: Uint8Array): Uint8Array {
    let spare: Uint8Array | undefined;
    const pending = this.pending?.selection;
    if (pending instanceof Uint8Array && pending.length === selection.length) {
      spare = pending;
      this.pending = null;
    } else {
      const index = this.spareSelections.findIndex((buffer) => buffer.length === selection.length);
      if (index !== -1) spare = this.spareSelections.splice(index, 1)[0];
    }
    if (spare === undefined) return selection.slice();
    spare.set(selection);
    return spare;
  }

  private recycle(buffer: Uint8Array): void {
    if (this.spareSelections.length < SPARE_SELECTIONS) this.spareSelections.push(buffer);
  }

  private connect(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<RenderReply>) => {
      // Replies queued before a failure terminated the worker change nothing.
      if (this.disposed || this.failure !== null) return;
      if (data.kind === "error") {
        this.fail(new Error(data.message));
        return;
      }
      if (data.kind === "ready") {
        this.starting = false;
        this.capabilities = data;
        if (!data.presents && this.pending?.mode === "exact") {
          this.pending = null;
          this.onUnavailable();
          return;
        }
        this.dispatchPending();
        return;
      }
      for (const buffer of data.released) this.recycle(buffer);
      if (data.id <= this.drawnId || data.id > this.postedId) {
        this.fail(new Error("The render worker returned an unexpected frame"));
        return;
      }
      this.drawnId = data.id;
      this.onFrame(data);
    };
    worker.onerror = (event) => this.fail(new Error(`Render worker failed: ${event.message}`));
    worker.onmessageerror = () =>
      this.fail(new Error("The render worker sent an unreadable reply"));
    const offscreen = this.canvas.transferControlToOffscreen();
    worker.postMessage({ kind: "init", canvas: offscreen }, [offscreen]);
    this.sendBrushPort();
  }

  private dispatchPending(): void {
    const pending = this.pending;
    const capabilities = this.capabilities;
    if (pending === null || this.worker === null || capabilities === null) return;
    this.pending = null;
    const { mode, frame, colors, selection, order, fallbackOrder, focus } = pending;
    const transfer: Transferable[] = [];
    const id = ++this.nextId;
    const request: RenderRequest = {
      ...frame,
      kind: "frame",
      id,
      mode,
      ...this.frameCache.encode(frame.axes, colors, transfer),
      focus: focus === null ? null : { axis: focus.axis, active: focus.active },
    };
    if (!(selection instanceof Uint8Array)) {
      request.brushVersion = { link: selection.link, version: selection.version };
    } else if (this.sentSelection !== null && equalFlags(this.sentSelection, selection)) {
      this.recycle(selection);
    } else {
      if (this.sentSelection?.length === selection.length) this.sentSelection.set(selection);
      else this.sentSelection = selection.slice();
      request.selection = selection;
      transfer.push(selection.buffer);
    }
    if (focus !== null && request.focus !== null && focus.rows !== this.focusRows) {
      request.focus.rows = focus.rows.slice();
      transfer.push(request.focus.rows.buffer);
      this.focusRows = focus.rows;
    }
    if (order !== null && fallbackOrder !== null) {
      const drawOrder = capabilities.density ? order : fallbackOrder();
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
    }
    this.postedId = id;
    try {
      this.worker.postMessage(request, transfer);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.starting = false;
    this.pending = null;
    // Nothing reads the brush worker's selections any more.
    this.brushPort?.port.close();
    this.brushPort = null;
    this.postedId = this.drawnId;
    this.worker?.terminate();
    const failure = this.failure;
    setTimeout(() => {
      throw failure;
    }, 0);
    this.onUnavailable();
  }

  dispose(): void {
    this.disposed = true;
    this.starting = false;
    this.pending = null;
    this.postedId = this.drawnId;
    this.frameCache.clear();
    this.order = null;
    this.drawOrder = null;
    this.focusRows = null;
    this.sentSelection = null;
    this.brushPort?.port.close();
    this.brushPort = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

function equalFlags(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; ++index) if (a[index] !== b[index]) return false;
  return true;
}
