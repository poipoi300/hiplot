import { expect, test } from "bun:test";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";
import {
  type CanvasRenderer,
  type ContinuousEvaluation,
  connectRenderWorker,
  type RenderWorkerScope,
} from "./render_runtime";
import type { RenderMessage, RenderReply, RenderRequest } from "./render_types";
import { selectionDelta } from "./selection_delta";
import type { LineFocus, LineFrame } from "./webgl";

const finished = { milliseconds: 12, fullQuality: true, fromBlocks: false, drewEveryRow: true };
const offscreen = {} as OffscreenCanvas;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function request(id = 1, selection = new Uint8Array([1, 0, 1])): RenderRequest {
  const pixels = new Float32Array([1, 2, 3]);
  return {
    kind: "frame",
    id,
    mode: "exact",
    axes: [
      { column: 1, x: 0 },
      { column: 1, x: 10 },
    ],
    columns: [{ id: 1, pixels }],
    colors: {
      bins: new Uint32Array([0, 1, 2]),
      palette: [{ r: 255, g: 0, b: 0 }],
      colorMapBins: 1,
    },
    order: new Uint32Array([2, 0, 1]),
    drawOrder: new Uint32Array([2, 0, 1]),
    selection,
    focus: null,
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
}

/** The deltas of a request whose rows, colors and selection the worker already holds. */
function unchanged(id: number, mode: RenderRequest["mode"] = "exact"): RenderRequest {
  const next = request(id);
  next.mode = mode;
  next.columns = [];
  delete next.colors;
  delete next.order;
  delete next.drawOrder;
  delete next.selection;
  return next;
}

/** A canvas renderer whose frames finish when the test says so, or at once. */
function canvasRenderer(overrides: Partial<CanvasRenderer> = {}) {
  const frames: { frame: LineFrame; focus: LineFocus | null }[] = [];
  const presented: { pixels: Uint8ClampedArray; frame: unknown }[] = [];
  const pending: (() => void)[] = [];
  let busy = false;
  let manual = false;
  const renderer: CanvasRenderer = {
    densityRendering: true,
    softwareRendering: false,
    setRows() {},
    setDrawOrder() {},
    setColors() {},
    setSelection() {},
    drawCooperative: (frame, focus = null) => {
      frames.push({ frame, focus });
      if (!manual) return Promise.resolve();
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    present: (image, frame) => {
      presented.push({ pixels: image.pixels, frame });
    },
    get busy() {
      const was = busy;
      busy = false;
      return was;
    },
    finishedFrame: () => finished,
    contextLost: false,
    ...overrides,
  };
  return {
    renderer,
    frames,
    presented,
    /** Frames then wait for `complete`. */
    hold() {
      manual = true;
    },
    complete() {
      busy = true;
      pending.shift()?.();
    },
  };
}

function image(): ContinuousImage {
  return {
    pixels: new Uint8ClampedArray(4),
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
}

/** A continuous evaluation recording what the kernel was sent; refinements wait for `refine`. */
function evaluation() {
  const requests: ContinuousRequest[] = [];
  const refinements: { resolve: () => void; isCurrent: () => boolean }[] = [];
  let disposed = 0;
  const create = (): ContinuousEvaluation => ({
    render: (sent) => {
      requests.push(sent);
      return image();
    },
    renderCooperative: (sent, isCurrent) => {
      requests.push(sent);
      return new Promise((resolve) => {
        refinements.push({
          isCurrent,
          resolve: () => resolve(isCurrent() ? image() : null),
        });
      });
    },
    dispose: () => {
      disposed += 1;
    },
  });
  return {
    create,
    requests,
    refinements,
    get disposed() {
      return disposed;
    },
  };
}

function runtime(
  createRenderer: (canvas: OffscreenCanvas) => CanvasRenderer | null,
  createContinuous: () => ContinuousEvaluation = evaluation().create,
  init = true,
) {
  const replies: RenderReply[] = [];
  const transfers: Transferable[][] = [];
  const scope: RenderWorkerScope = {
    onmessage: null,
    postMessage: (reply, transfer) => {
      replies.push(reply);
      transfers.push(transfer);
    },
  };
  connectRenderWorker(scope, createRenderer, createContinuous);
  const send = (data: RenderMessage) => scope.onmessage?.({ data } as MessageEvent<RenderMessage>);
  if (init) send({ kind: "init", canvas: offscreen });
  return {
    replies,
    transfers,
    send,
    frames: () =>
      replies.filter(
        (reply): reply is Extract<RenderReply, { kind: "frame" }> => reply.kind === "frame",
      ),
    last: () => replies[replies.length - 1],
  };
}

test("the worker reports what it can draw on the canvas the page gave it", () => {
  const canvases: OffscreenCanvas[] = [];
  const gpu = runtime((canvas) => {
    canvases.push(canvas);
    return canvasRenderer().renderer;
  });
  expect(canvases).toEqual([offscreen]);
  expect(gpu.replies).toEqual([{ kind: "ready", presents: true, density: true, blocks: true }]);
  const software = runtime(() => canvasRenderer({ softwareRendering: true }).renderer);
  expect(software.replies).toEqual([
    { kind: "ready", presents: true, density: true, blocks: false },
  ]);
  expect(runtime(() => null).replies).toEqual([
    { kind: "ready", presents: false, density: false, blocks: false },
  ]);
  expect(
    runtime(() => {
      throw new Error("init failed");
    }).replies,
  ).toEqual([{ kind: "error", message: "init failed" }]);
  const twice = runtime(() => null);
  twice.send({ kind: "init", canvas: offscreen });
  expect(twice.last()).toEqual({
    kind: "error",
    message: "The render worker was initialized twice",
  });
  const early = runtime(() => null, undefined, false);
  early.send(request());
  expect(early.last()).toEqual({
    kind: "error",
    message: "A frame reached the render worker before its canvas",
  });
  // A failed worker ignores everything after its error.
  early.send({ kind: "init", canvas: offscreen });
  expect(early.replies).toHaveLength(1);
});

test("exact frames keep their rows and reply once the GPU finished them", async () => {
  const surface = canvasRenderer();
  surface.hold();
  const worker = runtime(() => surface.renderer);
  worker.send(request(1));
  expect(worker.frames()).toHaveLength(0);
  surface.complete();
  await settled();
  expect(worker.frames()).toEqual([
    {
      kind: "frame",
      id: 1,
      mode: "exact",
      finished,
      continuous: null,
      pixels: null,
      released: [],
    },
  ]);
  const [first] = surface.frames;
  expect(first.frame.axes[0].pixels).toBe(first.frame.axes[1].pixels);
  worker.send(unchanged(2));
  surface.complete();
  await settled();
  expect(worker.frames()).toHaveLength(2);
  expect(surface.frames[1].frame.axes[0].pixels).toBe(first.frame.axes[0].pixels);
});

test("requests during a frame only update state: the next frame draws the latest", async () => {
  const surface = canvasRenderer();
  surface.hold();
  const selections: Uint8Array[] = [];
  surface.renderer.setSelection = (selection) => {
    selections.push(selection);
  };
  const worker = runtime(() => surface.renderer);
  const selected = [
    new Uint8Array([1, 1, 1]),
    new Uint8Array([0, 1, 1]),
    new Uint8Array([0, 0, 1]),
  ];
  worker.send(request(1, selected[0]));
  worker.send(request(2, selected[1]));
  const third = request(3, selected[2]);
  third.width = 30;
  worker.send(third);
  surface.complete();
  await settled();
  // Replaced selections go back once the frame that may have used them finished.
  expect(worker.frames().map((frame) => [frame.id, frame.released])).toEqual([
    [1, [selected[0], selected[1]]],
  ]);
  expect(worker.transfers[worker.transfers.length - 1]).toEqual([
    selected[0].buffer,
    selected[1].buffer,
  ]);
  surface.complete();
  await settled();
  expect(worker.frames().map((frame) => frame.id)).toEqual([1, 3]);
  expect(surface.frames.map(({ frame }) => frame.width)).toEqual([10, 30]);
  expect(selections).toEqual([selected[0], selected[2]]);
});

test("the worker keeps a brush focus's rows until new ones arrive, and needs them first", async () => {
  const surface = canvasRenderer();
  const missing = runtime(() => surface.renderer);
  const unfocused = request();
  unfocused.focus = { axis: 1, active: true };
  missing.send(unfocused);
  await settled();
  expect(missing.last()).toEqual({ kind: "error", message: "A brush focus needs its rows" });
  const worker = runtime(() => surface.renderer);
  const rows = new Uint8Array([1, 1, 1]);
  const first = request(1);
  first.focus = { axis: 1, active: true, rows };
  worker.send(first);
  await settled();
  const next = unchanged(2);
  next.focus = { axis: 1, active: false };
  worker.send(next);
  await settled();
  worker.send(unchanged(3));
  await settled();
  expect(surface.frames.slice(-3).map(({ focus }) => focus)).toEqual([
    { axis: 1, active: true, rows },
    { axis: 1, active: false, rows },
    null,
  ]);
});

test("continuous frames send the kernel only what changed and show on the canvas", async () => {
  const surface = canvasRenderer();
  const density = evaluation();
  const worker = runtime(() => surface.renderer, density.create);
  const first = request(1);
  first.mode = "continuous";
  first.draft = true;
  worker.send(first);
  await settled();
  worker.send({ ...unchanged(2, "continuous"), draft: true });
  await settled();
  expect(
    density.requests.map((sent) => [sent.columns.length, sent.colors, sent.selection]),
  ).toEqual([
    [1, first.colors, first.selection],
    [0, undefined, undefined],
  ]);
  expect(surface.presented).toHaveLength(2);
  expect(surface.presented[0].frame).toMatchObject({ width: 10, height: 8, pixelRatio: 2 });
  const { pixels: _, ...metrics } = image();
  expect(
    worker.frames().map((frame) => [frame.mode, frame.finished, frame.continuous, frame.pixels]),
  ).toEqual([
    ["continuous", finished, metrics, null],
    ["continuous", finished, metrics, null],
  ]);
});

test("without a canvas, continuous images return to the page and exact frames fail", async () => {
  const density = evaluation();
  const worker = runtime(() => null, density.create);
  const first = request(1);
  first.mode = "continuous";
  first.draft = true;
  worker.send(first);
  await settled();
  const [frame] = worker.frames();
  expect(frame.finished).toBeNull();
  expect(frame.pixels).toEqual(new Uint8ClampedArray(4));
  expect(worker.transfers[worker.transfers.length - 1]).toEqual([
    (frame.pixels as Uint8ClampedArray).buffer,
  ]);
  worker.send(unchanged(2));
  await settled();
  expect(worker.last()).toEqual({ kind: "error", message: "Exact lines need the worker's canvas" });
});

test("a gesture's draft or another mode preempts refinement; refinements otherwise finish", async () => {
  const surface = canvasRenderer();
  const density = evaluation();
  const worker = runtime(() => surface.renderer, density.create);
  const first = request(1);
  first.mode = "continuous";
  worker.send(first);
  // A later refinement waits for the one drawing.
  worker.send(unchanged(2, "continuous"));
  expect(density.refinements[0].isCurrent()).toBe(true);
  density.refinements[0].resolve();
  await settled();
  expect(worker.frames().map((frame) => frame.id)).toEqual([1]);
  // A draft preempts the next refinement, whose result is dropped.
  worker.send({ ...unchanged(3, "continuous"), draft: true });
  expect(density.refinements[1].isCurrent()).toBe(false);
  density.refinements[1].resolve();
  await settled();
  expect(worker.frames().map((frame) => frame.id)).toEqual([1, 3]);
  // So does an exact frame, which then releases the density kernel.
  worker.send(unchanged(4, "continuous"));
  worker.send(unchanged(5));
  expect(density.refinements[2].isCurrent()).toBe(false);
  density.refinements[2].resolve();
  await settled();
  expect(worker.frames().map((frame) => [frame.id, frame.mode])).toEqual([
    [1, "continuous"],
    [3, "continuous"],
    [5, "exact"],
  ]);
  expect(density.disposed).toBe(1);
  // A new kernel is sent every column, the colors and the selection again.
  worker.send({ ...unchanged(6, "continuous"), draft: true });
  await settled();
  const resent = density.requests[density.requests.length - 1];
  expect(resent.columns).toHaveLength(1);
  expect(resent.colors).toBeDefined();
  expect(resent.selection).toBeDefined();
});

test("render worker frames fail loudly on missing state and unfinished frames", async () => {
  const missingColumn = runtime(() => canvasRenderer().renderer);
  missingColumn.send({ ...request(), columns: [] });
  expect(missingColumn.last()).toEqual({
    kind: "error",
    message: "Missing render worker column 1",
  });
  const missingRows = runtime(() => canvasRenderer().renderer);
  const rowless = request();
  delete rowless.order;
  missingRows.send(rowless);
  await settled();
  expect(missingRows.last()).toEqual({
    kind: "error",
    message: "Exact frames need rows, a draw order and colors",
  });
  const selectionless = runtime(() => canvasRenderer().renderer);
  const unselected = request();
  delete unselected.selection;
  selectionless.send(unselected);
  await settled();
  expect(selectionless.last()).toEqual({ kind: "error", message: "A frame needs a selection" });
  const colorless = runtime(() => canvasRenderer().renderer);
  const uncolored = request();
  uncolored.mode = "continuous";
  delete uncolored.colors;
  colorless.send(uncolored);
  await settled();
  expect(colorless.last()).toEqual({
    kind: "error",
    message: "Continuous frames need colors",
  });
  const unfinished = runtime(() => canvasRenderer({ finishedFrame: () => null }).renderer);
  unfinished.send(request());
  await settled();
  expect(unfinished.last()).toEqual({
    kind: "error",
    message: "Render worker did not finish its frame",
  });
  const failing = runtime(
    () =>
      canvasRenderer({
        drawCooperative: async () => {
          throw "draw failed";
        },
      }).renderer,
  );
  failing.send(request(1));
  await settled();
  expect(failing.last()).toEqual({ kind: "error", message: "draw failed" });
  failing.send(request(2));
  await settled();
  expect(failing.replies.filter((reply) => reply.kind === "error")).toHaveLength(1);
});

test("a frame whose context was lost fails instead of waiting for its fence forever", async () => {
  const worker = runtime(
    () =>
      canvasRenderer({
        get busy() {
          return true;
        },
        contextLost: true,
      }).renderer,
  );
  worker.send(request());
  await settled();
  expect(worker.last()).toEqual({
    kind: "error",
    message: "The render worker lost its WebGL context",
  });
});

/** 32 rows a word, as the brush worker's bits. */
function bitsOf(flags: number[]): Uint32Array {
  const bits = new Uint32Array(Math.ceil(flags.length / 32));
  flags.forEach((flag, row) => {
    if (flag === 1) bits[row >>> 5] |= 1 << (row & 31);
  });
  return bits;
}

/** Resolves once the worker's message ports delivered what was posted. */
const delivered = async (until: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !until(); ++attempt) await settled();
};

test("frames naming a brush selection wait for it, then draw the newest with its own count", async () => {
  const selections: number[][] = [];
  const target = canvasRenderer({
    setSelection: (selected) => {
      selections.push(Array.from(selected));
    },
  });
  const worker = runtime(() => target.renderer);
  const channel = new MessageChannel();
  worker.send({ kind: "brush", port: channel.port2, link: 1 });
  const named = (id: number, version: number, link = 1): RenderRequest => {
    const next = id === 1 ? request(1) : unchanged(id);
    delete next.selection;
    next.brushVersion = { link, version };
    return next;
  };
  worker.send(named(1, 1));
  await settled();
  expect(worker.frames()).toHaveLength(0);
  let sent = bitsOf([1, 0, 1]);
  channel.port1.postMessage(
    selectionDelta(null, sent, { link: 1, version: 1, rowCount: 3, count: 2 }),
  );
  await delivered(() => worker.frames().length === 1);
  expect(selections).toEqual([[1, 0, 1]]);
  expect(target.frames[0].frame).toMatchObject({ selectedCount: 2, contextCount: 1 });
  // Changes only: the newest version draws, whatever the frame named.
  const next = bitsOf([0, 1, 1]);
  channel.port1.postMessage(
    selectionDelta(sent, next, { link: 1, version: 2, rowCount: 3, count: 2 }),
  );
  sent = next;
  const last = bitsOf([0, 0, 1]);
  channel.port1.postMessage(
    selectionDelta(sent, last, { link: 1, version: 3, rowCount: 3, count: 1 }),
  );
  await settled();
  await settled();
  worker.send(named(2, 2));
  await delivered(() => worker.frames().length === 2);
  expect(selections[1]).toEqual([0, 0, 1]);
  expect(target.frames[1].frame).toMatchObject({ selectedCount: 1, contextCount: 2 });
  // The page's own selection still draws as before.
  const paged = unchanged(3);
  paged.selection = new Uint8Array([1, 1, 1]);
  worker.send(paged);
  await delivered(() => worker.frames().length === 3);
  expect(selections[2]).toEqual([1, 1, 1]);
  expect(target.frames[2].frame).toMatchObject({ selectedCount: 2, contextCount: 1 });
  // A new port replaces the selection: frames wait for the new brush worker's first.
  const replaced = new MessageChannel();
  worker.send({ kind: "brush", port: replaced.port2, link: 2 });
  worker.send(named(4, 1, 2));
  await settled();
  expect(worker.frames()).toHaveLength(3);
  channel.port1.postMessage(
    selectionDelta(null, bitsOf([1, 1, 1]), { link: 1, version: 9, rowCount: 3, count: 3 }),
  );
  await settled();
  expect(worker.frames()).toHaveLength(3);
  replaced.port1.postMessage(
    selectionDelta(null, bitsOf([1, 1, 0]), { link: 2, version: 1, rowCount: 3, count: 2 }),
  );
  await delivered(() => worker.frames().length === 4);
  expect(selections[3]).toEqual([1, 1, 0]);
  for (const port of [channel.port1, replaced.port1]) port.close();
});

test("continuous frames get a copy of each brush selection version, once", async () => {
  const density = evaluation();
  const worker = runtime(() => canvasRenderer().renderer, density.create);
  const channel = new MessageChannel();
  worker.send({ kind: "brush", port: channel.port2, link: 1 });
  channel.port1.postMessage(
    selectionDelta(null, bitsOf([1, 0, 1]), { link: 1, version: 1, rowCount: 3, count: 2 }),
  );
  const draft = (id: number, version: number, link = 1): RenderRequest => {
    const next = id === 1 ? request(1) : unchanged(id);
    next.mode = "continuous";
    next.draft = true;
    delete next.selection;
    next.brushVersion = { link, version };
    return next;
  };
  await settled();
  worker.send(draft(1, 1));
  await delivered(() => worker.frames().length === 1);
  worker.send(draft(2, 1));
  await delivered(() => worker.frames().length === 2);
  expect(Array.from(density.requests[0].selection ?? [])).toEqual([1, 0, 1]);
  expect(density.requests[0]).toMatchObject({ selectedCount: 2, contextCount: 1 });
  expect(density.requests[1].selection).toBeUndefined();
  const copy = density.requests[0].selection;
  channel.port1.postMessage(
    selectionDelta(bitsOf([1, 0, 1]), bitsOf([0, 1, 1]), {
      link: 1,
      version: 2,
      rowCount: 3,
      count: 2,
    }),
  );
  await settled();
  worker.send(draft(3, 2));
  await delivered(() => worker.frames().length === 3);
  expect(Array.from(density.requests[2].selection ?? [])).toEqual([0, 1, 1]);
  // The kernel's earlier copy is its own.
  expect(Array.from(copy ?? [])).toEqual([1, 0, 1]);
  channel.port1.close();
});

test("brush selections that do not fit the frame, or arrive out of order, fail loudly", async () => {
  const mismatched = runtime(() => canvasRenderer().renderer);
  const wide = new MessageChannel();
  mismatched.send({ kind: "brush", port: wide.port2, link: 1 });
  wide.port1.postMessage(
    selectionDelta(null, bitsOf([1, 0, 1, 1]), { link: 1, version: 1, rowCount: 4, count: 3 }),
  );
  await settled();
  const named = request(1);
  delete named.selection;
  named.brushVersion = { link: 1, version: 1 };
  mismatched.send(named);
  await delivered(() => mismatched.last()?.kind === "error");
  expect(mismatched.last()).toEqual({
    kind: "error",
    message: "The brush selection and the frame's rows differ",
  });
  const reordered = runtime(() => canvasRenderer().renderer);
  const late = new MessageChannel();
  reordered.send({ kind: "brush", port: late.port2, link: 1 });
  late.port1.postMessage(
    selectionDelta(null, bitsOf([1, 0, 1]), { link: 1, version: 2, rowCount: 3, count: 2 }),
  );
  late.port1.postMessage(
    selectionDelta(null, bitsOf([1, 1, 1]), { link: 1, version: 1, rowCount: 3, count: 3 }),
  );
  await delivered(() => reordered.last()?.kind === "error");
  expect(reordered.last()).toEqual({ kind: "error", message: "Selection 1 arrived after 2" });
  for (const port of [wide.port1, late.port1]) port.close();
});

test("a new link's selections are never mistaken for the old link's, by frames or the density kernel", async () => {
  const density = evaluation();
  const target = canvasRenderer();
  const worker = runtime(() => target.renderer, density.create);
  const first = new MessageChannel();
  worker.send({ kind: "brush", port: first.port2, link: 1 });
  first.port1.postMessage(
    selectionDelta(null, bitsOf([1, 0, 1]), { link: 1, version: 3, rowCount: 3, count: 2 }),
  );
  const continuous = (id: number, link: number, version: number): RenderRequest => {
    const next = id === 1 ? request(1) : unchanged(id);
    next.mode = "continuous";
    next.draft = true;
    delete next.selection;
    next.brushVersion = { link, version };
    return next;
  };
  await settled();
  worker.send(continuous(1, 1, 3));
  await delivered(() => worker.frames().length === 1);
  // The same version number on the next link is another selection: the kernel gets it.
  const second = new MessageChannel();
  worker.send({ kind: "brush", port: second.port2, link: 2 });
  second.port1.postMessage(
    selectionDelta(null, bitsOf([0, 1, 0]), { link: 2, version: 3, rowCount: 3, count: 1 }),
  );
  await settled();
  worker.send(continuous(2, 2, 3));
  await delivered(() => worker.frames().length === 2);
  expect(Array.from(density.requests[1].selection ?? [])).toEqual([0, 1, 0]);
  // A frame of the old link waits, whatever version the new link reaches.
  worker.send(continuous(3, 1, 5));
  second.port1.postMessage(
    selectionDelta(bitsOf([0, 1, 0]), bitsOf([1, 1, 0]), {
      link: 2,
      version: 9,
      rowCount: 3,
      count: 2,
    }),
  );
  await settled();
  await settled();
  expect(worker.frames()).toHaveLength(2);
  worker.send(continuous(4, 2, 9));
  await delivered(() => worker.frames().length === 3);
  expect(worker.frames()[2].id).toBe(4);
  // A delta of another link on this port is a protocol error.
  second.port1.postMessage(
    selectionDelta(null, bitsOf([1, 1, 1]), { link: 1, version: 10, rowCount: 3, count: 3 }),
  );
  await delivered(() => worker.last()?.kind === "error");
  expect(worker.last()).toEqual({
    kind: "error",
    message: "A selection of link 1 reached link 2",
  });
  for (const port of [first.port1, second.port1]) port.close();
});
