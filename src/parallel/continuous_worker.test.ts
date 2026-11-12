import { describe, expect, test } from "bun:test";
import type { ContinuousWorkerScope } from "./continuous_entry";
import { ContinuousRuntime } from "./continuous_runtime";
import type { ContinuousImage, ContinuousRequest, ContinuousUpdate } from "./continuous_types";
import { ContinuousRenderer } from "./continuous_worker";
import type { LineColors, LineFrame } from "./webgl";

class WorkerDouble {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly requests: ContinuousRequest[] = [];
  terminated = false;

  postMessage(request: ContinuousRequest, transfer: Transferable[]): void {
    this.requests.push(structuredClone(request, { transfer }));
  }

  terminate(): void {
    this.terminated = true;
  }

  finish(index: number): void {
    const request = this.requests[index];
    this.onmessage?.({ data: { id: request.id, image: resultImage() } } as MessageEvent);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

function resultImage(): ContinuousImage {
  return {
    pixels: new Uint8ClampedArray([255, 0, 0, 128]),
    width: 1,
    height: 1,
    milliseconds: 0,
    countMs: 0,
    rasterMs: 0,
    rows: 2,
    axisBins: 256,
    evaluatedColumns: 1,
    evaluatedPairs: 1,
  };
}

function source(): { frame: LineFrame; colors: LineColors; selection: Uint8Array } {
  return {
    frame: {
      axes: [
        { x: 0, pixels: new Float32Array([1, 2]) },
        { x: 16, pixels: new Float32Array([2, 3]) },
      ],
      width: 16,
      height: 8,
      lineWidth: 1,
      pixelRatio: 1,
      curved: true,
      draft: false,
      resolution: 1,
      drawnRows: 2,
      selectedCount: 2,
      contextCount: 0,
      contextColor: { r: 0, g: 0, b: 0 },
      contextAlpha: 0.2,
      colorMode: "mean",
    },
    colors: { bins: new Uint32Array([0, 0]), palette: [{ r: 255, g: 0, b: 0 }], colorMapBins: 0 },
    selection: new Uint8Array([1, 1]),
  };
}

const ready = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("local density retains deltas and publishes every row without starting a worker", async () => {
  const images: ContinuousImage[] = [];
  const renderer = new ContinuousRenderer(
    (image) => images.push(image),
    () => {
      throw new Error("Cheap density must not start a worker");
    },
    "local",
  );
  const { frame, colors, selection } = source();
  const idle = async () => {
    while (renderer.busy) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    renderer.draw(frame, colors, selection);
    await idle();
    expect(images).toHaveLength(1);
    expect(images[0].rows).toBe(selection.length);
    renderer.draw(frame, colors, selection);
    await idle();
    expect(images[1].evaluatedPairs).toBe(0);
    selection[1] = 0;
    renderer.draw({ ...frame, selectedCount: 1, contextCount: 1 }, colors, selection);
    await idle();
    expect(images[2].rows).toBe(2);
    expect(images[2].evaluatedPairs).toBeGreaterThan(0);
    expect(images[2].pixels).not.toEqual(images[1].pixels);
  } finally {
    renderer.dispose();
  }
});

function workerRequest(id: number, draft = false): ContinuousRequest {
  const { frame, colors, selection } = source();
  return {
    ...frame,
    id,
    draft,
    axes: frame.axes.map((axis, index) => ({ column: index + 1, x: axis.x })),
    columns: frame.axes.map((axis, index) => ({ id: index + 1, pixels: axis.pixels })),
    colors,
    selection,
  };
}

test("local cooperative validation rejects through its promise so the host can release busy", async () => {
  const runtime = new ContinuousRuntime();
  try {
    const work = runtime.renderCooperative({ ...workerRequest(1), height: Number.NaN }, () => true);
    await expect(work).rejects.toThrow("axis height");
  } finally {
    runtime.dispose();
  }
});

class ControlledEvaluator {
  readonly drafts: { frame: ContinuousRequest; update: ContinuousUpdate }[] = [];
  readonly refinements: {
    frame: ContinuousRequest;
    update: ContinuousUpdate;
    isCurrent: () => boolean;
    resolve: (image: ContinuousImage | null) => void;
    reject: (error: Error) => void;
  }[] = [];

  render(frame: ContinuousRequest, update: ContinuousUpdate): ContinuousImage {
    this.drafts.push({ frame, update });
    return resultImage();
  }

  renderCooperative(
    frame: ContinuousRequest,
    update: ContinuousUpdate,
    isCurrent: () => boolean,
  ): Promise<ContinuousImage | null> {
    return new Promise((resolve, reject) => {
      this.refinements.push({ frame, update, isCurrent, resolve, reject });
    });
  }
}

async function controlledScope(evaluator: ControlledEvaluator): Promise<{
  scope: ContinuousWorkerScope;
  replies: { id: number; image?: ContinuousImage; error?: string }[];
  transfers: Transferable[][];
}> {
  const previousHandler = self.onmessage;
  const { connectContinuousWorker } = await import("./continuous_entry");
  self.onmessage = previousHandler;
  const replies: { id: number; image?: ContinuousImage; error?: string }[] = [];
  const transfers: Transferable[][] = [];
  const scope: ContinuousWorkerScope = {
    onmessage: null,
    postMessage: (reply, transfer) => {
      replies.push(reply);
      transfers.push(transfer);
    },
  };
  connectContinuousWorker(scope, () => evaluator);
  return { scope, replies, transfers };
}

describe("single continuous worker channel", () => {
  test("transfers owned copies and retains column/color identities and unchanged masks", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].columns).toHaveLength(2);
    expect(worker.requests[0].curved).toBe(true);
    expect(worker.requests[0].colors?.bins).toEqual(colors.bins);
    expect(frame.axes[0].pixels.byteLength).toBe(8);
    expect(colors.bins.byteLength).toBe(8);
    expect(selection.byteLength).toBe(2);
    expect(renderer.busy).toBe(true);
    worker.finish(0);
    expect(renderer.busy).toBe(false);
    expect(received).toHaveLength(1);
    renderer.draw(frame, colors, selection);
    const unchanged = worker.requests[1];
    expect(unchanged.columns).toHaveLength(0);
    expect(unchanged.colors).toBeUndefined();
    expect(unchanged.selection).toBeUndefined();
    worker.finish(1);
    selection[0] = 0;
    renderer.draw(frame, colors, selection);
    expect(worker.requests[2].selection).toEqual(new Uint8Array([0, 1]));
    expect(selection.byteLength).toBe(2);
    renderer.dispose();
    expect(worker.terminated).toBe(true);
    expect(renderer.busy).toBe(false);
  });

  test("finite bursts coalesce to latest pending and reject obsolete images", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    renderer.draw({ ...frame, width: 20 }, colors, selection);
    renderer.draw({ ...frame, width: 30 }, colors, selection);
    expect(worker.requests).toHaveLength(1);
    worker.finish(0);
    expect(received).toHaveLength(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].width).toBe(30);
    worker.finish(1);
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("a new gesture dispatches before release refinement completes and ignores its stale image", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw({ ...frame, draft: true }, colors, selection);
    expect(renderer.refining).toBe(false);
    await ready();
    worker.finish(0);
    renderer.draw(frame, colors, selection);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].draft).toBe(false);
    expect(renderer.refining).toBe(true);

    selection[0] = 0;
    renderer.draw({ ...frame, draft: true }, colors, selection);
    expect(worker.requests).toHaveLength(3);
    expect(worker.requests[2].draft).toBe(true);
    expect(worker.requests[2].selection).toEqual(new Uint8Array([0, 1]));
    expect(renderer.refining).toBe(false);
    expect(renderer.busy).toBe(true);
    worker.finish(1);
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(true);
    worker.finish(2);
    expect(received).toHaveLength(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("active drafts stay paced and coalesce to the latest state after preempting refinement", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    renderer.draw({ ...frame, width: 20 }, colors, selection);
    renderer.draw({ ...frame, draft: true, width: 30 }, colors, selection);
    expect(worker.requests).toHaveLength(2);
    renderer.draw({ ...frame, draft: true, width: 40 }, colors, selection);
    renderer.draw({ ...frame, draft: true, width: 50 }, colors, selection);
    expect(worker.requests).toHaveLength(2);
    worker.finish(0);
    expect(worker.requests).toHaveLength(2);
    expect(received).toHaveLength(0);
    worker.finish(1);
    expect(worker.requests).toHaveLength(3);
    expect(worker.requests[2].width).toBe(50);
    expect(received).toHaveLength(0);
    worker.finish(2);
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("obsolete refinement errors cannot poison a newer draft or its idle channel", async () => {
    const worker = new WorkerDouble();
    const received: ContinuousImage[] = [];
    const renderer = new ContinuousRenderer(
      (image) => received.push(image),
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    await ready();
    renderer.draw({ ...frame, draft: true }, colors, selection);
    const staleError = { data: { id: worker.requests[0].id, error: "obsolete" } } as MessageEvent;
    worker.onmessage?.(staleError);
    expect(worker.terminated).toBe(false);
    expect(renderer.busy).toBe(true);
    worker.finish(1);
    worker.onmessage?.(staleError);
    worker.finish(0);
    expect(received).toHaveLength(1);
    expect(renderer.busy).toBe(false);
    renderer.draw({ ...frame, draft: true }, colors, selection);
    expect(worker.requests).toHaveLength(3);
    worker.finish(2);
    expect(received).toHaveLength(2);
    renderer.dispose();
  });

  test("a callback can queue the next paced gesture without reporting idle early", async () => {
    const worker = new WorkerDouble();
    const { frame, colors, selection } = source();
    let accepted = 0;
    const renderer = new ContinuousRenderer(
      () => {
        expect(renderer.busy).toBe(true);
        if (++accepted === 1) renderer.draw(frame, colors, selection);
      },
      async () => worker.asWorker(),
    );
    renderer.draw(frame, colors, selection);
    await ready();
    worker.finish(0);
    expect(worker.requests).toHaveLength(2);
    expect(renderer.busy).toBe(true);
    worker.finish(1);
    expect(accepted).toBe(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("a draft queued by refinement publication remains busy until its own image arrives", async () => {
    const worker = new WorkerDouble();
    const { frame, colors, selection } = source();
    let accepted = 0;
    const renderer = new ContinuousRenderer(
      () => {
        expect(renderer.busy).toBe(true);
        expect(renderer.refining).toBe(false);
        if (++accepted === 1) renderer.draw({ ...frame, draft: true }, colors, selection);
      },
      async () => worker.asWorker(),
    );
    renderer.draw(frame, colors, selection);
    await ready();
    worker.finish(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].draft).toBe(true);
    expect(renderer.busy).toBe(true);
    worker.finish(1);
    expect(accepted).toBe(2);
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });

  test("pending masks and geometry positions are snapshotted before later caller mutations", async () => {
    const worker = new WorkerDouble();
    const renderer = new ContinuousRenderer(
      () => {},
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    selection[0] = 0;
    frame.axes[0].x = -100;
    await ready();
    expect(worker.requests[0].selection).toEqual(new Uint8Array([1, 1]));
    expect(worker.requests[0].axes[0].x).toBe(0);
    renderer.dispose();
  });

  test("shared geometry identities are transferred once and refer to one column ID", async () => {
    const worker = new WorkerDouble();
    const renderer = new ContinuousRenderer(
      () => {},
      async () => worker.asWorker(),
    );
    const { frame, colors, selection } = source();
    frame.axes[1].pixels = frame.axes[0].pixels;
    renderer.draw(frame, colors, selection);
    await ready();
    expect(worker.requests[0].columns).toHaveLength(1);
    expect(worker.requests[0].axes[0].column).toBe(worker.requests[0].axes[1].column);
    renderer.dispose();
  });

  test("late worker initialization after disposal terminates without dispatch", async () => {
    const worker = new WorkerDouble();
    let resolve: ((worker: Worker) => void) | undefined;
    const initializing = new Promise<Worker>((done) => {
      resolve = done;
    });
    const renderer = new ContinuousRenderer(
      () => {},
      () => initializing,
    );
    const { frame, colors, selection } = source();
    renderer.draw(frame, colors, selection);
    renderer.dispose();
    resolve?.(worker.asWorker());
    await ready();
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(0);
    expect(() => renderer.draw(frame, colors, selection)).toThrow("disposed");
  });

  test("mismatched source lengths fail before starting a worker", () => {
    const { frame, colors } = source();
    const renderer = new ContinuousRenderer(() => {});
    expect(() => renderer.draw(frame, colors, new Uint8Array(1))).toThrow("same rows");
    expect(renderer.busy).toBe(false);
    renderer.dispose();
  });
});

describe("cooperative continuous worker protocol", () => {
  test("drafts run before refinement settles and retain every dispatched column, color and mask delta", async () => {
    const evaluator = new ControlledEvaluator();
    const { scope, replies, transfers } = await controlledScope(evaluator);
    const first = workerRequest(1);
    const firstCompletion = scope.onmessage?.({ data: first } as MessageEvent<ContinuousRequest>);
    expect(evaluator.refinements).toHaveLength(1);
    expect(evaluator.refinements[0].isCurrent()).toBe(true);

    const replacement: ContinuousRequest = {
      ...first,
      id: 2,
      axes: [{ column: 3, x: 0 }, first.axes[1]],
      columns: [{ id: 3, pixels: new Float32Array([5, 6]) }],
      colors: {
        bins: new Uint32Array([0, 1]),
        palette: [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 },
        ],
        colorMapBins: 0,
      },
      selection: new Uint8Array([0, 1]),
    };
    const replacementCompletion = scope.onmessage?.({
      data: replacement,
    } as MessageEvent<ContinuousRequest>);
    expect(evaluator.refinements).toHaveLength(2);
    expect(evaluator.refinements[0].isCurrent()).toBe(false);
    expect(evaluator.refinements[1].isCurrent()).toBe(true);

    const draft: ContinuousRequest = {
      ...replacement,
      id: 3,
      draft: true,
      columns: [],
      colors: undefined,
      selection: undefined,
    };
    const draftCompletion = scope.onmessage?.({ data: draft } as MessageEvent<ContinuousRequest>);
    expect(evaluator.drafts).toHaveLength(1);
    expect(evaluator.refinements[1].isCurrent()).toBe(false);
    const update = evaluator.drafts[0].update;
    expect(update.colors).toBe(evaluator.refinements[1].update.colors);
    expect(update.colors.bins).toEqual(new Uint32Array([0, 1]));
    expect(update.colors.palette[1]).toEqual({ r: 0, g: 0, b: 255 });
    expect(update.selectedCount).toBe(1);
    expect(update.contextCount).toBe(1);
    expect(update.changedRows).toBe(0);
    expect(update.pairs.map((pair) => pair.key)).toEqual(["-1:3", "3:2", "2:-1"]);
    expect(update.pairs[1].histogram).toBe(evaluator.refinements[1].update.pairs[1].histogram);
    expect(replies.map((reply) => reply.id)).toEqual([3]);
    expect(transfers[0]).toHaveLength(1);
    expect(transfers[0][0] === replies[0].image?.pixels.buffer).toBe(true);

    // A late success or rejection is obsolete regardless of the backend's cancellation result.
    evaluator.refinements[0].resolve(resultImage());
    evaluator.refinements[1].reject(new Error("obsolete refinement failure"));
    await Promise.all([firstCompletion, replacementCompletion, draftCompletion]);
    expect(replies.map((reply) => reply.id)).toEqual([3]);
  });

  test("obsolete cancellation returns no response and does not interrupt the current refinement", async () => {
    const evaluator = new ControlledEvaluator();
    const { scope, replies } = await controlledScope(evaluator);
    const first = workerRequest(1);
    const firstCompletion = scope.onmessage?.({ data: first } as MessageEvent<ContinuousRequest>);
    const next: ContinuousRequest = {
      ...first,
      id: 2,
      columns: [],
      colors: undefined,
      selection: undefined,
    };
    const nextCompletion = scope.onmessage?.({ data: next } as MessageEvent<ContinuousRequest>);
    evaluator.refinements[0].resolve(null);
    await firstCompletion;
    expect(replies).toHaveLength(0);
    expect(evaluator.refinements[1].isCurrent()).toBe(true);
    evaluator.refinements[1].resolve(resultImage());
    await nextCompletion;
    expect(replies.map((reply) => reply.id)).toEqual([2]);
  });

  test("current synchronous and cooperative failures still report their frame IDs", async () => {
    const evaluator = new ControlledEvaluator();
    evaluator.render = () => {
      throw new Error("draft raster failure");
    };
    const { scope, replies } = await controlledScope(evaluator);
    const draft = workerRequest(1, true);
    await scope.onmessage?.({ data: draft } as MessageEvent<ContinuousRequest>);
    expect(replies).toEqual([{ id: 1, error: "draft raster failure" }]);
    const full: ContinuousRequest = {
      ...draft,
      id: 2,
      draft: false,
      columns: [],
      colors: undefined,
      selection: undefined,
    };
    const fullCompletion = scope.onmessage?.({ data: full } as MessageEvent<ContinuousRequest>);
    evaluator.refinements[0].reject(new Error("full raster failure"));
    await fullCompletion;
    expect(replies[1]).toEqual({ id: 2, error: "full raster failure" });
  });
});
