import { expect, spyOn, test } from "bun:test";
import { connectExactWorker, type ExactSurface, type ExactWorkerScope } from "./exact_runtime";
import type { ExactReply, ExactRequest } from "./exact_types";
import { ExactRenderer } from "./exact_worker";
import { type LineColors, type LineFrame, WebGLLineRenderer } from "./webgl";

const finished = { milliseconds: 12, fullQuality: true };
const ready = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function source() {
  const pixels = new Float32Array([1, 2, 3]);
  const frame: LineFrame = {
    axes: [
      { x: 0, pixels },
      { x: 10, pixels },
    ],
    width: 10,
    height: 8,
    pixelRatio: 2,
    lineWidth: 1,
    curved: false,
    draft: false,
    resolution: 1,
    drawnRows: 3,
    selectedCount: 2,
    contextCount: 1,
    contextColor: { r: 1, g: 2, b: 3 },
    contextAlpha: 0.2,
    colorMode: "highest",
  };
  const colors: LineColors = {
    bins: new Uint32Array([0, 1, 2]),
    palette: [{ r: 255, g: 0, b: 0 }],
    colorMapBins: 1,
  };
  const selection = new Uint8Array([1, 0, 1]);
  const order = new Uint32Array([2, 0, 1]);
  return { frame, colors, selection, order, fallback: () => order };
}

class WorkerDouble {
  onmessage: ((event: MessageEvent<ExactReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: ExactRequest[] = [];
  terminated = false;
  postMessage(request: ExactRequest, transfer: Transferable[]): void {
    this.requests.push(structuredClone(request, { transfer }));
  }
  terminate() {
    this.terminated = true;
  }
  reply(reply: ExactReply) {
    this.onmessage?.({ data: reply } as MessageEvent<ExactReply>);
  }
  finish(index: number) {
    let closed = false;
    const bitmap = {
      close: () => {
        closed = true;
      },
    } as ImageBitmap;
    this.reply({ kind: "frame", id: this.requests[index].id, bitmap, finished });
    return closed;
  }
  asWorker() {
    return this as unknown as Worker;
  }
}

function draw(renderer: ExactRenderer, input = source()) {
  renderer.draw(input.frame, input.colors, input.selection, input.order, input.fallback);
}

test("exact requests wait for capability discovery and transfer owned row snapshots", async () => {
  const worker = new WorkerDouble();
  const images: number[] = [];
  const renderer = new ExactRenderer(
    (_, timing) => {
      expect(renderer.busy).toBe(true);
      images.push(timing.milliseconds);
    },
    () => {
      throw Error("Unexpected fallback");
    },
    async () => worker.asWorker(),
  );
  const input = source();
  draw(renderer, input);
  input.selection[0] = 0;
  await ready();
  expect(renderer.busy).toBe(true);
  expect(worker.requests).toHaveLength(0);
  worker.reply({ kind: "ready", density: true });
  const first = worker.requests[0];
  expect(first.selection).toEqual(new Uint8Array([1, 0, 1]));
  expect(first.columns).toHaveLength(1);
  expect(first.axes[0].column).toBe(first.axes[1].column);
  expect(first.order).toBe(first.drawOrder);
  expect(input.frame.axes[0].pixels.byteLength).toBe(12);
  expect(input.colors.bins.byteLength).toBe(12);
  expect(input.order.byteLength).toBe(12);
  expect(worker.finish(0)).toBe(true);
  expect(images).toEqual([12]);
  expect(renderer.busy).toBe(false);
  draw(renderer, input);
  expect(worker.requests[1].columns).toHaveLength(0);
  expect(worker.requests[1].colors).toBeUndefined();
  expect(worker.requests[1].order).toBeUndefined();
  expect(worker.requests[1].drawOrder).toBeUndefined();
  worker.finish(1);
  renderer.dispose();
  expect(worker.terminated).toBe(true);
  expect(() => draw(renderer)).toThrow("disposed");
});

test("exact bursts publish only the latest complete image and preserve busy during publication", async () => {
  const worker = new WorkerDouble();
  let images = 0;
  const input = source();
  const renderer = new ExactRenderer(
    () => {
      images++;
      if (images === 1) draw(renderer, input);
    },
    () => {},
    async () => worker.asWorker(),
  );
  draw(renderer, input);
  await ready();
  worker.reply({ kind: "ready", density: true });
  draw(renderer, { ...input, frame: { ...input.frame, width: 20 } });
  draw(renderer, { ...input, frame: { ...input.frame, width: 30 } });
  expect(worker.requests).toHaveLength(1);
  expect(worker.finish(0)).toBe(true);
  expect(images).toBe(0);
  expect(worker.requests[1].width).toBe(30);
  worker.finish(1);
  expect(worker.requests).toHaveLength(3);
  expect(renderer.busy).toBe(true);
  worker.finish(2);
  expect(images).toBe(2);
  expect(renderer.busy).toBe(false);
  renderer.dispose();
});

test("worker capability selects sorted alpha order and dropped columns are retransmitted", async () => {
  const worker = new WorkerDouble();
  const renderer = new ExactRenderer(
    () => {},
    () => {},
    async () => worker.asWorker(),
  );
  const input = source();
  const sorted = new Uint32Array([0, 1, 2]);
  input.fallback = () => sorted;
  draw(renderer, input);
  await ready();
  worker.reply({ kind: "ready", density: false });
  expect(worker.requests[0].drawOrder).toEqual(sorted);
  worker.finish(0);
  draw(renderer, { ...input, frame: { ...input.frame, axes: [] } });
  worker.finish(1);
  draw(renderer, input);
  expect(worker.requests[2].columns).toHaveLength(1);
  worker.finish(2);
  draw(renderer, source());
  expect(worker.requests[3].order).toBeDefined();
  expect(worker.requests[3].colors).toBeDefined();
  renderer.dispose();
});

test("unsupported worker WebGL falls back and disposed workers close late bitmaps", async () => {
  const worker = new WorkerDouble();
  let unavailable = false;
  const renderer = new ExactRenderer(
    () => {},
    () => {
      unavailable = true;
    },
    async () => worker.asWorker(),
  );
  draw(renderer);
  draw(renderer);
  await ready();
  worker.reply({ kind: "ready", density: null });
  expect(unavailable).toBe(true);
  expect(renderer.busy).toBe(false);
  expect(worker.terminated).toBe(true);
  let closed = false;
  worker.reply({
    kind: "frame",
    id: 1,
    bitmap: {
      close: () => {
        closed = true;
      },
    } as ImageBitmap,
    finished,
  });
  expect(closed).toBe(true);
  worker.reply({ kind: "ready", density: true });
  const earlyWorker = new WorkerDouble();
  const early = new ExactRenderer(
    () => {},
    () => {},
    async () => earlyWorker.asWorker(),
  );
  draw(early);
  early.dispose();
  await ready();
  expect(earlyWorker.terminated).toBe(true);
});

test("invalid row shapes fail before worker creation", () => {
  const renderer = new ExactRenderer(
    () => {},
    () => {},
  );
  const input = source();
  expect(() => draw(renderer, { ...input, selection: new Uint8Array(0) })).toThrow("same rows");
  expect(() =>
    draw(renderer, { ...input, colors: { ...input.colors, bins: new Uint32Array(0) } }),
  ).toThrow("same rows");
  expect(() =>
    draw(renderer, {
      ...input,
      frame: { ...input.frame, axes: [{ x: 0, pixels: new Float32Array(0) }] },
    }),
  ).toThrow("same rows");
});

test("worker failures clear busy, terminate and remain visible", async () => {
  const scheduled: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    for (const failure of [
      "message",
      "event",
      "unreadable",
      "unexpected",
      "post",
      "factory",
    ] as const) {
      const worker = new WorkerDouble();
      const renderer = new ExactRenderer(
        () => {},
        () => {},
        async () => {
          if (failure === "factory") throw "factory failure";
          return worker.asWorker();
        },
      );
      if (failure === "post")
        worker.postMessage = () => {
          throw "post failure";
        };
      draw(renderer);
      await ready();
      if (failure !== "factory") {
        worker.reply({ kind: "ready", density: true });
        if (failure === "message") worker.reply({ kind: "error", message: "render failed" });
        if (failure === "event") worker.onerror?.({ message: "failed" } as ErrorEvent);
        if (failure === "unreadable") worker.onmessageerror?.();
        if (failure === "unexpected")
          worker.reply({ kind: "frame", id: 999, bitmap: { close() {} } as ImageBitmap, finished });
      }
      expect(renderer.busy).toBe(false);
      expect(() => draw(renderer)).toThrow();
      expect(() => scheduled.shift()?.()).toThrow();
      renderer.dispose();
    }
  } finally {
    timer.mockRestore();
  }
});

function request(): ExactRequest {
  const input = source();
  return {
    ...input.frame,
    id: 1,
    axes: input.frame.axes.map((axis) => ({ column: 1, x: axis.x })),
    columns: [{ id: 1, pixels: input.frame.axes[0].pixels }],
    colors: input.colors,
    order: input.order,
    drawOrder: input.order,
    selection: input.selection,
  };
}

function runtime(create: () => ExactSurface | null) {
  const replies: ExactReply[] = [];
  const scope: ExactWorkerScope = {
    onmessage: null,
    postMessage: (reply) => {
      replies.push(reply);
    },
  };
  connectExactWorker(scope, create);
  return {
    scope,
    replies,
    send: async (data: ExactRequest) => scope.onmessage?.({ data } as MessageEvent<ExactRequest>),
  };
}

test("worker retains immutable columns and publishes only after cooperative rendering completes", async () => {
  let complete: (() => void) | undefined;
  let busyReads = 0;
  const seen: LineFrame[] = [];
  const bitmap = {} as ImageBitmap;
  const surface: ExactSurface = {
    canvas: { width: 1, height: 1, transferToImageBitmap: () => bitmap },
    renderer: {
      densityRendering: true,
      setRows() {},
      setDrawOrder() {},
      setColors() {},
      setSelection() {},
      drawCooperative: (frame) => {
        seen.push(frame);
        return new Promise<void>((resolve) => {
          complete = resolve;
        });
      },
      get busy() {
        return busyReads++ === 0;
      },
      finishedFrame: () => finished,
    },
  };
  const worker = runtime(() => surface);
  const work = worker.send(request());
  expect(worker.replies).toHaveLength(1);
  expect(surface.canvas.width).toBe(20);
  expect(surface.canvas.height).toBe(16);
  complete?.();
  await work;
  expect(worker.replies[1]).toEqual({ kind: "frame", id: 1, bitmap, finished });
  expect(seen[0].axes[0].pixels).toBe(seen[0].axes[1].pixels);
  const next = request();
  delete next.colors;
  delete next.order;
  delete next.drawOrder;
  next.columns = [];
  const second = worker.send(next);
  complete?.();
  await second;
  expect(worker.replies).toHaveLength(3);
  expect(seen[1].axes[0].pixels).toBe(seen[0].axes[0].pixels);
});

test("worker reports unavailable contexts, initialization and frame failures", async () => {
  expect(runtime(() => null).replies).toEqual([{ kind: "ready", density: null }]);
  expect(
    runtime(() => {
      throw new Error("init failed");
    }).replies,
  ).toEqual([{ kind: "error", message: "init failed" }]);
  const surface: ExactSurface = {
    canvas: { width: 20, height: 16, transferToImageBitmap: () => ({}) as ImageBitmap },
    renderer: {
      densityRendering: false,
      setRows() {},
      setDrawOrder() {},
      setColors() {},
      setSelection() {},
      drawCooperative: async () => {},
      busy: false,
      finishedFrame: () => null,
    },
  };
  const worker = runtime(() => surface);
  const invalid = request();
  delete invalid.order;
  await worker.send(invalid);
  expect(worker.replies[worker.replies.length - 1]).toEqual({
    kind: "error",
    message: "Exact worker needs rows, draw order and colors",
  });
  await worker.send({ ...request(), columns: [] });
  expect(worker.replies[worker.replies.length - 1]).toEqual({
    kind: "error",
    message: "Missing exact worker column 1",
  });
  await worker.send(request());
  expect(worker.replies[worker.replies.length - 1]).toEqual({
    kind: "error",
    message: "Exact worker did not finish its frame",
  });
  surface.renderer.drawCooperative = async () => {
    throw "draw failed";
  };
  await worker.send(request());
  expect(worker.replies[worker.replies.length - 1]).toEqual({
    kind: "error",
    message: "draw failed",
  });
});

test("cooperative line batches wait for their fences and release failed fences", async () => {
  for (const failure of [null, "context", "fence"] as const) {
    let signaled = false,
      deleted = 0,
      batches = 0;
    const renderer = Object.create(WebGLLineRenderer.prototype) as WebGLLineRenderer;
    Object.assign(renderer, {
      softwareRendering: failure === null,
      gl: {
        SYNC_GPU_COMMANDS_COMPLETE: 1,
        SYNC_STATUS: 2,
        SIGNALED: 3,
        fenceSync: () => (failure === "fence" ? null : {}),
        flush() {},
        isContextLost: () => failure === "context",
        getSyncParameter: () => {
          signaled = !signaled;
          return signaled ? 0 : 3;
        },
        deleteSync: () => {
          deleted++;
        },
      },
      *drawFrame(_frame: LineFrame, size: () => number) {
        for (let i = 0; i < 3; i++) {
          expect(size()).toBeGreaterThan(0);
          expect(size()).toBeLessThanOrEqual(32768);
          expect(deleted).toBe(i);
          batches++;
          yield;
        }
      },
    });
    const work = renderer.drawCooperative(source().frame);
    if (failure === null) {
      await work;
      expect(batches).toBe(3);
      expect(deleted).toBe(3);
    } else {
      await expect(work).rejects.toThrow(failure === "context" ? "lost" : "fence");
      expect(deleted).toBe(failure === "context" ? 1 : 0);
    }
  }
});
