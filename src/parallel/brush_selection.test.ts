import { expect, spyOn, test } from "bun:test";
import type { FilterRange } from "../filters";
import { type Datapoint, ParamType } from "../types";
import { connectBrushWorker } from "./brush_runtime";
import { BrushSelection, type BrushWorkers, type SelectionResult } from "./brush_selection";
import type { BrushMessage, BrushReply } from "./brush_types";
import type { AxisSelection } from "./selection";
import type { SelectionIndexRequest } from "./selection_index";
import { buildSelectionIndex } from "./selection_sort";

const rows: Datapoint[] = Array.from({ length: 8 }, (_, index) => ({
  uid: String(index),
  from_uid: null,
  x: index,
  c: index % 2 === 0 ? "even" : "odd",
}));
const xRange = (min: number, max: number): FilterRange => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
});
const even: FilterRange = { col: "c", type: ParamType.CATEGORICAL, min: "even", max: "even" };
const brushes = (...axes: [string, FilterRange[]][]) => new Map<string, AxisSelection>(axes);
const flags = (result: SelectionResult | null) => Array.from(result?.mask ?? []);

/**
 * The brush worker in this thread, delivering messages in later microtasks as
 * a worker would, and a sorting worker that answers on the port it is given.
 */
class BrushWorkerDouble {
  onmessage: ((event: MessageEvent<BrushReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: BrushMessage[] = [];
  terminated = false;
  /** Holds replies until released, to keep a request in flight. */
  holding = false;
  private readonly held: BrushReply[] = [];
  private readonly scope = {
    onmessage: null as ((event: MessageEvent<BrushMessage>) => void) | null,
    postMessage: (reply: BrushReply) => {
      if (this.holding) this.held.push(reply);
      else this.deliver(reply);
    },
  };

  constructor() {
    connectBrushWorker(this.scope);
  }

  postMessage(message: BrushMessage): void {
    this.messages.push(message);
    queueMicrotask(() => {
      if (!this.terminated) this.scope.onmessage?.({ data: message } as MessageEvent<BrushMessage>);
    });
  }

  release(): void {
    this.holding = false;
    for (const reply of this.held.splice(0)) this.deliver(reply);
  }

  private deliver(reply: BrushReply): void {
    queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent<BrushReply>));
  }

  terminate(): void {
    this.terminated = true;
  }

  kinds(kind: BrushMessage["kind"]): BrushMessage[] {
    return this.messages.filter((message) => message.kind === kind);
  }
}

class IndexWorkerDouble {
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  port: MessagePort | null = null;

  postMessage({ port }: { port: MessagePort }): void {
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<SelectionIndexRequest>) =>
      port.postMessage({
        id: data.id,
        index: buildSelectionIndex(data.column),
        wasmMemoryBytes: 32,
      });
  }

  terminate(): void {
    this.terminated = true;
    this.port?.close();
  }
}

function workers() {
  const brush = new BrushWorkerDouble();
  const index = new IndexWorkerDouble();
  const created: BrushWorkers = {
    brush: brush as unknown as Worker,
    index: index as unknown as Worker,
  };
  return { brush, index, create: async () => created };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("selects on the worker, sending each column once and then only brush ranges", async () => {
  const { brush, index, create } = workers();
  const selection = new BrushSelection(rows, create);
  selection.warm(xRange(0, 7));
  const first = await selection.select(brushes(["x", [xRange(2, 5)]]), null, true);
  expect(flags(first)).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  expect(first?.count).toBe(4);
  expect(first?.publish).toBe(true);
  const both = await selection.select(brushes(["x", [xRange(2, 5)]], ["c", [even]]), null, false);
  expect(flags(both)).toEqual([0, 0, 1, 0, 1, 0, 0, 0]);
  expect(both?.mask).not.toBe(first?.mask);
  expect(brush.kinds("init")).toHaveLength(1);
  expect(brush.kinds("column")).toHaveLength(2);
  expect(selection.onPage).toBe(false);
  await selection.prepare(brushes(["x", [xRange(0, 1)]]));
  expect(selection.wasmMemoryBytes).toBe(32);
  expect(selection.selectedRows(both?.mask ?? new Uint8Array()).map((row) => row.uid)).toEqual([
    "2",
    "4",
  ]);
  selection.dispose();
  expect(brush.terminated && index.terminated).toBe(true);
  expect(() => selection.select(brushes(), null, false)).toThrow("disposed");
});

test("a request made while one is in flight replaces the one waiting, keeping its publication", async () => {
  const { brush, create } = workers();
  const selection = new BrushSelection(rows, create);
  const first = selection.select(brushes(["x", [xRange(0, 3)]]), null, false);
  await settled();
  brush.holding = true;
  const inFlight = selection.select(brushes(["x", [xRange(0, 4)]]), null, false);
  await settled();
  const replaced = selection.select(brushes(["x", [xRange(0, 5)]]), null, true);
  const newest = selection.select(brushes(["x", [xRange(0, 6)]]), null, false);
  brush.release();
  expect(flags(await first)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  expect(flags(await inFlight)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
  expect(await replaced).toBeNull();
  const result = await newest;
  expect(flags(result)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
  expect(result?.publish).toBe(true);
  expect(brush.kinds("select")).toHaveLength(3);
  selection.dispose();
});

test("no brush selects every row at once, and drops an older reply still in flight", async () => {
  const { brush, create } = workers();
  const selection = new BrushSelection(rows, create);
  await selection.select(brushes(["x", [xRange(0, 3)]]), null, false);
  brush.holding = true;
  const older = selection.select(brushes(["x", [xRange(0, 4)]]), "c", false);
  await settled();
  const cleared = await selection.select(brushes(), "x", true);
  expect(flags(cleared)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(cleared?.passing?.dimension).toBe("x");
  expect(Array.from(cleared?.passing?.rows ?? [])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  brush.release();
  expect(await older).toBeNull();
  selection.dispose();
});

test("passing rows arrive with a focus and are reused while the other axes keep their brushes", async () => {
  const { create } = workers();
  const selection = new BrushSelection(rows, create);
  const first = await selection.select(brushes(["x", [xRange(0, 3)]], ["c", [even]]), "x", false);
  expect(first?.passing?.dimension).toBe("x");
  expect(Array.from(first?.passing?.rows ?? [])).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  const moved = await selection.select(brushes(["x", [xRange(0, 6)]], ["c", [even]]), "x", false);
  expect(moved?.passing).toBe(first?.passing ?? null);
  const unfocused = await selection.select(brushes(["x", [xRange(0, 6)]]), null, false);
  expect(unfocused?.passing).toBeNull();
  selection.dispose();
});

test("without workers the page selects, with the same results", async () => {
  const selection = new BrushSelection(rows, async () => null);
  selection.warm(xRange(0, 7));
  await settled();
  expect(selection.onPage).toBe(true);
  selection.warm(xRange(0, 7));
  await selection.prepare(brushes(["x", [xRange(0, 1)]]));
  const result = await selection.select(brushes(["x", [xRange(2, 5)]], ["c", [even]]), "c", true);
  expect(flags(result)).toEqual([0, 0, 1, 0, 1, 0, 0, 0]);
  expect(result?.count).toBe(2);
  expect(Array.from(result?.passing?.rows ?? [])).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  expect(result?.publish).toBe(true);
  expect(selection.wasmMemoryBytes).toBe(0);
  // The page's own masks are not handed anywhere.
  if (result !== null) selection.recycle(result.mask);
  expect(flags(await selection.select(brushes(["x", [xRange(0, 1)]]), null, false))).toEqual([
    1, 1, 0, 0, 0, 0, 0, 0,
  ]);
  selection.dispose();
});

test("a failing worker is rethrown, and the page answers the requests it left", async () => {
  const scheduled: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    for (const failure of ["error", "reply", "unreadable", "unexpected"] as const) {
      const { brush, index, create } = workers();
      const selection = new BrushSelection(rows, create);
      await selection.select(brushes(["x", [xRange(0, 1)]]), null, false);
      brush.holding = true;
      const inFlight = selection.select(brushes(["x", [xRange(0, 2)]]), null, true);
      const waiting = selection.select(brushes(["x", [xRange(0, 3)]]), null, false);
      await settled();
      if (failure === "error") index.onerror?.({ message: "sort failed" } as ErrorEvent);
      if (failure === "reply")
        brush.onmessage?.({ data: { kind: "error", message: "lost" } } as MessageEvent<BrushReply>);
      if (failure === "unreadable") brush.onmessageerror?.();
      if (failure === "unexpected") {
        brush.onmessage?.({
          data: { kind: "prepared", id: 99, wasmMemoryBytes: 0 },
        } as MessageEvent<BrushReply>);
      }
      expect(selection.onPage).toBe(true);
      expect(await inFlight).toBeNull();
      const result = await waiting;
      expect(flags(result)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
      expect(result?.publish).toBe(true);
      expect(scheduled).toHaveLength(1);
      expect(() => scheduled.pop()?.()).toThrow();
      // Replies the workers still send change nothing.
      brush.release();
      await settled();
      expect(flags(await selection.select(brushes(["x", [xRange(5, 7)]]), null, false))).toEqual([
        0, 0, 0, 0, 0, 1, 1, 1,
      ]);
      selection.dispose();
    }
    const blocked = new BrushSelection(rows, () => Promise.reject(new Error("blocked")));
    const first = blocked.select(brushes(["x", [xRange(0, 2)]]), null, true);
    expect(flags(await first)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    expect(blocked.onPage).toBe(true);
    expect(() => scheduled.pop()?.()).toThrow("blocked");
    blocked.dispose();
  } finally {
    timer.mockRestore();
  }
});

test("workers that start after disposal are terminated, and preparing before they start waits for them", async () => {
  const late = workers();
  let connect: ((created: BrushWorkers) => void) | undefined;
  const disposed = new BrushSelection(
    rows,
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  disposed.warm(xRange(0, 7));
  disposed.dispose();
  connect?.({ brush: late.brush as unknown as Worker, index: late.index as unknown as Worker });
  await settled();
  expect(late.brush.terminated && late.index.terminated).toBe(true);
  expect(late.brush.messages).toHaveLength(0);

  const { brush, create } = workers();
  const selection = new BrushSelection(rows, create);
  await selection.prepare(brushes(["c", [even]]));
  expect(brush.kinds("prepare")).toHaveLength(1);
  expect(selection.wasmMemoryBytes).toBe(32);
  selection.dispose();
});

test("a worker that cannot take a message moves the selection onto the page", async () => {
  const scheduled: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    const { brush, create } = workers();
    const selection = new BrushSelection(rows, create);
    await selection.select(brushes(["x", [xRange(0, 1)]]), null, false);
    brush.postMessage = () => {
      throw new Error("DataCloneError");
    };
    const result = await selection.select(brushes(["x", [xRange(6, 7)]]), null, false);
    expect(flags(result)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
    expect(selection.onPage).toBe(true);
    expect(() => scheduled.pop()?.()).toThrow("DataCloneError");
    selection.dispose();
  } finally {
    timer.mockRestore();
  }
});

test("a recycled mask carries a later selection instead of a new buffer per move", async () => {
  const { brush, create } = workers();
  const selection = new BrushSelection(rows, create);
  const first = await selection.select(brushes(["x", [xRange(0, 3)]]), null, false);
  if (first === null) throw new Error("Expected a selection");
  const kept = Array.from(first.mask);
  selection.recycle(first.mask);
  const second = await selection.select(brushes(["x", [xRange(4, 7)]]), null, false);
  expect(second?.mask).toBe(first.mask);
  expect(flags(second)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  expect(kept).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  const third = await selection.select(brushes(["x", [xRange(0, 1)]]), null, false);
  expect(third?.mask).not.toBe(first.mask);
  const [sent] = brush.kinds("select").slice(1, 2);
  expect(sent?.kind === "select" && sent.spare).toBe(first.mask);
  // A mask of another length belongs to other rows.
  expect(() => selection.recycle(new Uint8Array(3))).toThrow("3 rows");
  await selection.select(brushes(["x", [xRange(0, 2)]]), null, false);
  expect(brush.kinds("select").slice(-1)[0]).toMatchObject({ spare: null });
  selection.dispose();
});
