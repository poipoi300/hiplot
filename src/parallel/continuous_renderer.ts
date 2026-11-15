import type { ContinuousRuntime } from "./continuous_runtime";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";
import type { LineColors, LineFrame } from "./webgl";
import { WorkerFrameCache } from "./worker_payload";

type LocalRuntime = Pick<ContinuousRuntime, "renderCooperative" | "dispose">;

interface PendingFrame {
  id: number;
  frame: LineFrame;
  colors: LineColors;
  selection: Uint8Array;
}

/**
 * Continuous density on the page's main thread, where no render worker
 * exists (no workers, or no transferControlToOffscreen; see RenderWorker):
 * the retained kernel counts deltas, and a draft can preempt refinement.
 */
export class ContinuousRenderer {
  private readonly frameCache = new WorkerFrameCache();
  private runtime: LocalRuntime | null = null;
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
    private readonly createRuntime: () => Promise<LocalRuntime> = () =>
      import("./continuous_runtime").then(({ ContinuousRuntime }) => new ContinuousRuntime()),
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
    if (this.runtime === null) {
      this.pending = pending;
      if (!this.running) {
        this.running = true;
        void this.createRuntime()
          .then((runtime) => {
            if (this.disposed) {
              runtime.dispose();
              return;
            }
            this.runtime = runtime;
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

  private finish(id: number, image: ContinuousImage): void {
    if (this.disposed || id !== this.activeId) return;
    // The host paces gesture requests. Unpaced finite bursts retain latest-only rejection.
    if (this.pending !== null) {
      this.dispatchPending();
      return;
    }
    // Publication still counts as busy, but completed refinement can no longer be preempted.
    this.activeDraft = true;
    try {
      this.onImage(image);
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
    const runtime = this.runtime;
    if (runtime === null) throw new Error("Continuous renderer has not initialized");
    const request: ContinuousRequest = {
      ...frame,
      id,
      ...this.frameCache.encode(frame.axes, colors, []),
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
    }
    this.activeId = id;
    this.activeDraft = frame.draft;
    this.running = true;
    const isCurrent = (): boolean => !this.disposed && id === this.activeId;
    void runtime.renderCooperative(request, isCurrent).then(
      (image) => {
        if (image !== null && isCurrent()) this.finish(id, image);
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
    // Asynchronous failures must be visible, not an indefinitely busy plot.
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
    this.runtime?.dispose();
    this.runtime = null;
  }
}
