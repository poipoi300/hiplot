import type { ContinuousRuntime } from "./continuous_runtime";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";
import type { LineColors, LineFrame } from "./webgl";
import { WorkerFrameCache } from "./worker_payload";

interface PendingFrame {
  id: number;
  frame: LineFrame;
  colors: LineColors;
  selection: Uint8Array;
}

export type ContinuousWorkerFactory = () => Promise<Worker>;

/** Retained all-row channel, local or worker; drafts can preempt refinement. */
export class ContinuousRenderer {
  private worker: Worker | null = null;
  private readonly frameCache = new WorkerFrameCache();
  private local: ContinuousRuntime | null = null;
  private nextFrameId = 0;
  private activeId = 0;
  private running = false;
  private activeDraft = true;
  private pending: PendingFrame | null = null;
  private disposed = false;
  private failure: Error | null = null;
  private selection: Uint8Array | null = null;

  constructor(
    private readonly onImage: (image: ContinuousImage) => void,
    private readonly createWorker: ContinuousWorkerFactory = async () => {
      const { default: InlineWorker } = await import("./continuous_entry?worker&inline");
      return new InlineWorker();
    },
    readonly execution: "local" | "worker" = "worker",
  ) {}

  get busy(): boolean {
    return this.running || this.pending !== null;
  }

  get refining(): boolean {
    return this.running && !this.activeDraft;
  }

  draw(frame: LineFrame, colors: LineColors, selection: Uint8Array): void {
    if (this.disposed) throw new Error("Cannot draw with a disposed continuous renderer");
    if (this.failure !== null) throw this.failure;
    const rows = colors.bins.length;
    if (selection.length !== rows || frame.axes.some((axis) => axis.pixels.length !== rows)) {
      throw new Error(
        "Continuous renderer columns, colors and selection must identify the same rows",
      );
    }
    const pending: PendingFrame = {
      id: ++this.nextFrameId,
      frame: {
        ...frame,
        axes: frame.axes.map((axis) => ({ ...axis })),
        contextColor: { ...frame.contextColor },
      },
      colors,
      selection: selection.slice(),
    };
    if (this.worker === null && this.local === null) {
      this.pending = pending;
      if (!this.running) {
        this.running = true;
        void (
          this.execution === "local"
            ? import("./continuous_runtime").then(
                ({ ContinuousRuntime }) => new ContinuousRuntime(),
              )
            : this.createWorker()
        )
          .then((worker) => {
            if (this.disposed) {
              if ("terminate" in worker) worker.terminate();
              else worker.dispose();
              return;
            }
            if ("terminate" in worker) this.connect(worker);
            else this.local = worker;
            this.dispatchPending();
          })
          .catch((error: unknown) => {
            if (!this.disposed)
              this.fail(error instanceof Error ? error : new Error(String(error)));
          });
      }
      return;
    }
    if (this.running && !(frame.draft && this.refining)) {
      this.pending = pending;
      return;
    }
    this.pending = null;
    this.dispatch(pending);
  }

  private connect(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; image?: ContinuousImage; error?: string }>) => {
      this.finish(data);
    };
    worker.onerror = (event) => this.fail(new Error(`Continuous worker failed: ${event.message}`));
    worker.onmessageerror = () =>
      this.fail(new Error("Continuous worker returned an unreadable image"));
  }

  private finish(data: { id: number; image?: ContinuousImage; error?: string }): void {
    if (this.disposed || data.id < this.activeId) return;
    if (data.id !== this.activeId) {
      this.fail(new Error("Continuous worker returned an unexpected frame"));
      return;
    }
    if (data.error !== undefined) {
      this.fail(new Error(`Continuous renderer: ${data.error}`));
      return;
    }
    if (data.image === undefined) {
      this.fail(new Error("Continuous worker returned an unexpected frame"));
      return;
    }
    // The host paces gesture requests. Unpaced finite bursts retain latest-only rejection.
    if (this.pending !== null) {
      this.dispatchPending();
      return;
    }
    // Publication still counts as busy, but completed refinement can no longer be preempted.
    this.activeDraft = true;
    try {
      this.onImage(data.image);
    } finally {
      this.running = false;
      if (!this.disposed) this.dispatchPending();
    }
  }

  private dispatchPending(): void {
    const next = this.pending;
    this.pending = null;
    if (next !== null) this.dispatch(next);
  }

  private dispatch({ id, frame, colors, selection }: PendingFrame): void {
    if (this.worker === null && this.local === null)
      throw new Error("Continuous renderer has not initialized");
    const transfer: Transferable[] = [];
    const request: ContinuousRequest = {
      ...frame,
      id,
      ...this.frameCache.encode(frame.axes, colors, transfer),
    };
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
      request.selection = selection;
      transfer.push(selection.buffer);
    }
    this.activeId = id;
    this.activeDraft = frame.draft;
    this.running = true;
    if (this.worker !== null) {
      this.worker.postMessage(request, transfer);
      return;
    }
    const isCurrent = (): boolean => !this.disposed && id === this.activeId;
    void this.local?.renderCooperative(request, isCurrent).then(
      (image) => {
        if (image !== null && isCurrent()) this.finish({ id, image });
      },
      (error: unknown) => {
        if (isCurrent()) this.fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private fail(error: Error): void {
    this.failure = error;
    this.running = false;
    this.pending = null;
    this.worker?.terminate();
    // Async worker failures must be visible, not an indefinitely busy plot.
    setTimeout(() => {
      throw error;
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.pending = null;
    this.selection = null;
    this.frameCache.clear();
    this.worker?.terminate();
    this.worker = null;
    this.local?.dispose();
    this.local = null;
  }
}
