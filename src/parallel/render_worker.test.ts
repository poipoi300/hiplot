import { expect, spyOn, test } from "bun:test";
import type { RenderMessage, RenderReply, RenderRequest } from "./render_types";
import { RenderWorker, type WorkerFrame } from "./render_worker";
import type { LineColors, LineFrame } from "./webgl";

const finished = { milliseconds: 12, fullQuality: true, fromBlocks: false, drewEveryRow: true };
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
    transient: false,
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

type Input = ReturnType<typeof source>;

class WorkerDouble {
  onmessage: ((event: MessageEvent<RenderReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: RenderMessage[] = [];
  /** What each message transferred, before the clone detached it. */
  transfers: Transferable[][] = [];
  terminated = false;
  postMessage(message: RenderMessage, transfer: Transferable[]): void {
    this.transfers.push(transfer);
    this.messages.push(
      message.kind === "init" ? message : structuredClone(message, { transfer: [...transfer] }),
    );
  }
  get requests(): RenderRequest[] {
    return this.messages.filter((message): message is RenderRequest => message.kind === "frame");
  }
  terminate() {
    this.terminated = true;
  }
  reply(reply: RenderReply) {
    this.onmessage?.({ data: reply } as MessageEvent<RenderReply>);
  }
  ready(presents = true, density = true) {
    this.reply({ kind: "ready", presents, density, blocks: false });
  }
  finish(index: number, released: Uint8Array[] = []) {
    const request = this.requests[index];
    this.reply({
      kind: "frame",
      id: request.id,
      mode: request.mode,
      finished,
      continuous: null,
      pixels: null,
      released,
    });
  }
  asWorker() {
    return this as unknown as Worker;
  }
}

/** A canvas that hands its control over once, as a page's canvas does. */
function canvas() {
  const offscreen = { kind: "offscreen" } as unknown as OffscreenCanvas;
  let transfers = 0;
  return {
    offscreen,
    get transfers() {
      return transfers;
    },
    element: {
      transferControlToOffscreen: () => {
        transfers += 1;
        return offscreen;
      },
    } as unknown as HTMLCanvasElement,
  };
}

function renderer(
  worker: WorkerDouble,
  onFrame: (frame: WorkerFrame) => void = () => {},
  onUnavailable: () => void = () => {},
) {
  return new RenderWorker(canvas().element, onFrame, onUnavailable, async () => worker.asWorker());
}

function draw(target: RenderWorker, input: Input = source()) {
  target.drawExact(input.frame, input.colors, input.selection, input.order, input.fallback);
}

test("frames wait for the worker's canvas and transfer owned row snapshots", async () => {
  const worker = new WorkerDouble();
  const surface = canvas();
  const frames: WorkerFrame[] = [];
  const target = new RenderWorker(
    surface.element,
    (frame) => frames.push(frame),
    () => {
      throw Error("Unexpected fallback");
    },
    async () => worker.asWorker(),
  );
  const input = source();
  draw(target, input);
  input.selection[0] = 0;
  await ready();
  expect(target.busy).toBe(true);
  expect(target.presents).toBeNull();
  expect(worker.messages).toEqual([{ kind: "init", canvas: surface.offscreen }]);
  expect(worker.transfers[0]).toEqual([surface.offscreen]);
  worker.ready();
  expect(target.presents).toBe(true);
  const first = worker.requests[0];
  expect(first.mode).toBe("exact");
  expect(first.selection).toEqual(new Uint8Array([1, 0, 1]));
  expect(first.columns).toHaveLength(1);
  expect(first.axes[0].column).toBe(first.axes[1].column);
  expect(first.order).toBe(first.drawOrder);
  expect(input.frame.axes[0].pixels.byteLength).toBe(12);
  expect(input.colors.bins.byteLength).toBe(12);
  expect(input.order.byteLength).toBe(12);
  worker.finish(0);
  expect(frames.map((frame) => frame.finished)).toEqual([finished]);
  expect(target.busy).toBe(false);
  input.selection[0] = 1;
  draw(target, input);
  await ready();
  // Nothing changed: the worker keeps what it holds.
  const second = worker.requests[1];
  expect(second.columns).toHaveLength(0);
  expect(second.colors).toBeUndefined();
  expect(second.order).toBeUndefined();
  expect(second.drawOrder).toBeUndefined();
  expect(second.selection).toBeUndefined();
  target.dispose();
  expect(worker.terminated).toBe(true);
  expect(target.busy).toBe(false);
  expect(() => draw(target)).toThrow("disposed");
});

test("draws post at the end of their task without waiting for the worker's frame", async () => {
  const worker = new WorkerDouble();
  const target = renderer(worker);
  const input = source();
  draw(target, input);
  await ready();
  worker.ready();
  expect(worker.requests).toHaveLength(1);
  draw(target, { ...input, frame: { ...input.frame, width: 20 } });
  draw(target, { ...input, frame: { ...input.frame, width: 30 } });
  expect(worker.requests).toHaveLength(1);
  await ready();
  // The first frame is still drawing; the newest state goes out regardless.
  expect(worker.requests.map((request) => request.width)).toEqual([10, 30]);
  worker.finish(0);
  expect(target.busy).toBe(true);
  worker.finish(1);
  expect(target.busy).toBe(false);
  target.dispose();
});

test("a started worker sends no frame until one is drawn", async () => {
  const worker = new WorkerDouble();
  let created = 0;
  const surface = canvas();
  const target = new RenderWorker(
    surface.element,
    () => {},
    () => {},
    async () => {
      created++;
      return worker.asWorker();
    },
  );
  target.start();
  target.start();
  expect(target.busy).toBe(true);
  await ready();
  worker.ready();
  expect(created).toBe(1);
  expect(surface.transfers).toBe(1);
  expect(target.busy).toBe(false);
  expect(worker.requests).toHaveLength(0);
  draw(target);
  await ready();
  expect(worker.requests).toHaveLength(1);
  expect(created).toBe(1);
  target.dispose();
  expect(() => target.start()).toThrow("disposed");
});

test("worker capability selects sorted alpha order and dropped columns are retransmitted", async () => {
  const worker = new WorkerDouble();
  const target = renderer(worker);
  const input = source();
  const sorted = new Uint32Array([0, 1, 2]);
  input.fallback = () => sorted;
  draw(target, input);
  await ready();
  worker.ready(true, false);
  expect(worker.requests[0].drawOrder).toEqual(sorted);
  expect(worker.requests[0].order).toEqual(input.order);
  draw(target, { ...input, frame: { ...input.frame, axes: [] } });
  await ready();
  draw(target, input);
  await ready();
  expect(worker.requests[2].columns).toHaveLength(1);
  draw(target, source());
  await ready();
  expect(worker.requests[3].order).toBeDefined();
  expect(worker.requests[3].colors).toBeDefined();
  target.dispose();
});

test("a brush focus's rows go to the worker once per identity", async () => {
  const worker = new WorkerDouble();
  const target = renderer(worker);
  const input = source();
  const rows = new Uint8Array([1, 1, 0]);
  const focused = (active: boolean, focusRows = rows) =>
    target.drawExact(input.frame, input.colors, input.selection, input.order, input.fallback, {
      axis: 1,
      active,
      rows: focusRows,
    });
  focused(true);
  await ready();
  worker.ready();
  focused(false);
  await ready();
  focused(true, new Uint8Array([0, 1, 1]));
  await ready();
  expect(worker.requests.map((request) => request.focus)).toEqual([
    { axis: 1, active: true, rows },
    { axis: 1, active: false },
    { axis: 1, active: true, rows: new Uint8Array([0, 1, 1]) },
  ]);
  expect(() =>
    target.drawExact(input.frame, input.colors, input.selection, input.order, input.fallback, {
      axis: 1,
      active: true,
      rows: new Uint8Array(1),
    }),
  ).toThrow("same rows");
  target.dispose();
});

test("a selection is sent only when it changes, in buffers the worker returned", async () => {
  const worker = new WorkerDouble();
  const target = renderer(worker);
  const input = source();
  draw(target, input);
  await ready();
  worker.ready();
  expect(worker.requests[0].selection).toEqual(input.selection);
  const returned = new Uint8Array(3);
  worker.finish(0, [returned]);
  draw(target, { ...input, selection: new Uint8Array([0, 1, 0]) });
  await ready();
  expect(worker.requests[1].selection).toEqual(new Uint8Array([0, 1, 0]));
  expect(worker.transfers[2]).toContain(returned.buffer);
  target.dispose();
});

test("a worker without a canvas hands exact frames to the page and returns continuous images", async () => {
  const worker = new WorkerDouble();
  const frames: WorkerFrame[] = [];
  let unavailable = 0;
  const target = renderer(
    worker,
    (frame) => frames.push(frame),
    () => {
      unavailable += 1;
    },
  );
  const input = source();
  draw(target, input);
  await ready();
  worker.ready(false, false);
  expect(unavailable).toBe(1);
  expect(target.busy).toBe(false);
  expect(target.presents).toBe(false);
  expect(target.blockFrames).toBe(false);
  expect(worker.requests).toHaveLength(0);
  expect(() => draw(target, input)).toThrow("cannot draw exact lines");
  target.drawContinuous({ ...input.frame, draft: true }, input.colors, input.selection);
  await ready();
  const request = worker.requests[0];
  expect(request.mode).toBe("continuous");
  expect(request.order).toBeUndefined();
  expect(request.focus).toBeNull();
  const pixels = new Uint8ClampedArray(4);
  const continuous = {
    width: 1,
    height: 1,
    milliseconds: 3,
    countMs: 1,
    rasterMs: 1,
    rows: 3,
    axisBins: 256,
    evaluatedColumns: 1,
    evaluatedPairs: 1,
  };
  worker.reply({
    kind: "frame",
    id: request.id,
    mode: "continuous",
    finished: null,
    continuous,
    pixels,
    released: [],
  });
  expect(frames).toHaveLength(1);
  expect(frames[0].pixels).toBe(pixels);
  expect(frames[0].continuous).toEqual(continuous);
  expect(unavailable).toBe(1);
  target.dispose();
});

test("a ready worker without a canvas draws a waiting continuous frame", async () => {
  const worker = new WorkerDouble();
  let unavailable = 0;
  const target = renderer(
    worker,
    () => {},
    () => {
      unavailable += 1;
    },
  );
  const input = source();
  target.drawContinuous(input.frame, input.colors, input.selection);
  await ready();
  worker.ready(false, false);
  expect(unavailable).toBe(0);
  expect(worker.requests.map((request) => request.mode)).toEqual(["continuous"]);
  target.dispose();
});

test("invalid row shapes fail before worker creation", () => {
  const target = new RenderWorker(
    canvas().element,
    () => {},
    () => {},
  );
  const input = source();
  expect(() => draw(target, { ...input, selection: new Uint8Array(0) })).toThrow("same rows");
  expect(() =>
    draw(target, { ...input, colors: { ...input.colors, bins: new Uint32Array(0) } }),
  ).toThrow("same rows");
  expect(() =>
    draw(target, {
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
      "repeated",
      "post",
      "factory",
    ] as const) {
      const worker = new WorkerDouble();
      let unavailable = 0;
      const target = new RenderWorker(
        canvas().element,
        () => {},
        () => {
          unavailable += 1;
        },
        async () => {
          if (failure === "factory") throw "factory failure";
          return worker.asWorker();
        },
      );
      if (failure === "post") {
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          if (message.kind === "frame") throw "post failure";
          post(message, transfer);
        };
      }
      draw(target);
      await ready();
      if (failure !== "factory") {
        worker.ready();
        if (failure === "message") worker.reply({ kind: "error", message: "render failed" });
        if (failure === "event") worker.onerror?.({ message: "failed" } as ErrorEvent);
        if (failure === "unreadable") worker.onmessageerror?.();
        if (failure === "unexpected")
          worker.reply({
            kind: "frame",
            id: 999,
            mode: "exact",
            finished,
            continuous: null,
            pixels: null,
            released: [],
          });
        if (failure === "repeated") {
          worker.finish(0);
          worker.finish(0);
        }
      }
      expect(target.busy).toBe(false);
      expect(target.failed).toBe(true);
      // The plot then draws on the page; the failure stays visible.
      expect(unavailable).toBe(1);
      expect(() => draw(target)).toThrow();
      expect(() => scheduled.shift()?.()).toThrow();
      target.dispose();
    }
  } finally {
    timer.mockRestore();
  }
});

test("replies queued before a failure terminated the worker change nothing", async () => {
  const scheduled: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    const worker = new WorkerDouble();
    const frames: WorkerFrame[] = [];
    let unavailable = 0;
    const target = renderer(
      worker,
      (frame) => frames.push(frame),
      () => {
        unavailable += 1;
      },
    );
    draw(target);
    await ready();
    worker.ready();
    worker.reply({ kind: "error", message: "render failed" });
    worker.finish(0);
    worker.reply({ kind: "error", message: "again" });
    expect(frames).toHaveLength(0);
    expect(unavailable).toBe(1);
    expect(scheduled).toHaveLength(1);
  } finally {
    timer.mockRestore();
  }
});

test("replies after disposal are ignored and late workers terminate", async () => {
  const worker = new WorkerDouble();
  const frames: WorkerFrame[] = [];
  const target = renderer(worker, (frame) => frames.push(frame));
  draw(target);
  await ready();
  worker.ready();
  target.dispose();
  worker.finish(0);
  expect(frames).toHaveLength(0);
  const earlyWorker = new WorkerDouble();
  const early = renderer(earlyWorker);
  draw(early);
  early.dispose();
  await ready();
  expect(earlyWorker.terminated).toBe(true);
  expect(earlyWorker.messages).toHaveLength(0);
});
