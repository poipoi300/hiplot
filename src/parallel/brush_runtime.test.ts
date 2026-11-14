import { expect, test } from "bun:test";
import type { FilterRange } from "../filters";
import { type Datapoint, ParamType } from "../types";
import { type BrushWorkerScope, connectBrushWorker } from "./brush_runtime";
import type { BrushMessage, BrushReply } from "./brush_types";
import { selectionColumn } from "./selection_columns";
import type { SelectionIndexRequest, SelectionIndexResponse } from "./selection_index";
import { buildSelectionIndex } from "./selection_sort";

const rows: Datapoint[] = [
  { uid: "0", from_uid: null, x: 1, c: "a" },
  { uid: "1", from_uid: null, x: 5, c: "b" },
  { uid: "2", from_uid: null, x: 7, c: "a" },
  { uid: "3", from_uid: null, x: 3, c: "c" },
];
const xRange = (min: number, max: number): FilterRange => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
});
const cRange: FilterRange = { col: "c", type: ParamType.CATEGORICAL, min: "a", max: "b" };

/** A brush worker in this thread, with a sorting worker that answers on its port. */
function brushWorker(sorts = true) {
  const replies: BrushReply[] = [];
  const transfers: Transferable[][] = [];
  const scope: BrushWorkerScope = {
    onmessage: null,
    postMessage: (reply, transfer = []) => {
      replies.push(reply);
      transfers.push(transfer);
    },
  };
  connectBrushWorker(scope);
  const channel = new MessageChannel();
  const sorted: SelectionIndexRequest[] = [];
  channel.port2.onmessage = ({ data }: MessageEvent<SelectionIndexRequest>) => {
    sorted.push(data);
    if (!sorts) return;
    const response: SelectionIndexResponse = {
      id: data.id,
      index: buildSelectionIndex(data.column),
      wasmMemoryBytes: 64,
    };
    channel.port2.postMessage(response);
  };
  const send = (message: BrushMessage) =>
    scope.onmessage?.({ data: message } as MessageEvent<BrushMessage>);
  const init = () => send({ kind: "init", rowCount: rows.length, index: channel.port1 });
  const column = (range: FilterRange) =>
    send({ kind: "column", range, column: selectionColumn(rows, range) });
  const close = () => {
    channel.port1.close();
    channel.port2.close();
  };
  return { replies, transfers, sorted, send, init, column, close };
}

const selected = (reply: BrushReply | undefined) => {
  if (reply?.kind !== "selected") throw new Error(`Expected a selection, got ${reply?.kind}`);
  return reply;
};

test("selects from the columns sent, transferring copies, and sends passing rows only when they change", () => {
  const worker = brushWorker();
  worker.init();
  worker.column(xRange(0, 10));
  worker.column(cRange);
  worker.send({
    kind: "select",
    id: 1,
    axes: [
      ["x", [xRange(0, 6)]],
      ["c", [cRange]],
    ],
    focus: "x",
    spare: null,
  });
  const first = selected(worker.replies[0]);
  expect(first.id).toBe(1);
  expect(Array.from(first.mask)).toEqual([1, 1, 0, 0]);
  expect(first.count).toBe(2);
  if (first.passing === null) throw new Error("Expected the rows the other axes pass");
  expect(Array.from(first.passing)).toEqual([1, 1, 1, 0]);
  expect(worker.transfers[0]).toEqual([first.mask.buffer, first.passing.buffer]);
  // Moving the focus axis changes neither the other axes nor the rows they pass.
  worker.send({
    kind: "select",
    id: 2,
    axes: [
      ["x", [xRange(4, 10)]],
      ["c", [cRange]],
    ],
    focus: "x",
    spare: null,
  });
  const moved = selected(worker.replies[1]);
  expect(Array.from(moved.mask)).toEqual([0, 1, 1, 0]);
  expect(moved.mask).not.toBe(first.mask);
  expect(moved.passing).toBeNull();
  // A buffer the page hands back carries the next selection.
  const spare = new Uint8Array(rows.length);
  worker.send({ kind: "select", id: 5, axes: [["x", [xRange(4, 10)]]], focus: null, spare });
  const reused = selected(worker.replies[worker.replies.length - 1]);
  expect(reused.mask).toBe(spare);
  expect(Array.from(spare)).toEqual([0, 1, 1, 0]);
  worker.replies.pop();
  worker.transfers.pop();
  expect(worker.transfers[1]).toEqual([moved.mask.buffer]);
  // Another focus sends its own rows; no focus sends none.
  worker.send({ kind: "select", id: 3, axes: [["x", [xRange(4, 10)]]], focus: "c", spare: null });
  expect(Array.from(selected(worker.replies[2]).passing ?? [])).toEqual([0, 1, 1, 0]);
  worker.send({ kind: "select", id: 4, axes: [], focus: null, spare: null });
  const cleared = selected(worker.replies[3]);
  expect(Array.from(cleared.mask)).toEqual([1, 1, 1, 1]);
  expect(cleared.passing).toBeNull();
  worker.close();
});

test("prepare replies once the columns are sorted on the sorting worker's port", async () => {
  const worker = brushWorker();
  worker.init();
  worker.column(xRange(0, 10));
  worker.send({ kind: "prepare", id: 7, axes: [["x", [xRange(0, 6)]]] });
  await new Promise<void>((resolve) => {
    const wait = () => (worker.replies.length > 0 ? resolve() : setTimeout(wait, 1));
    wait();
  });
  expect(worker.sorted).toHaveLength(1);
  expect(worker.replies).toEqual([{ kind: "prepared", id: 7, wasmMemoryBytes: 64 }]);
  worker.close();
});

test("requests before initialization or for columns never sent reply an error", async () => {
  const worker = brushWorker(false);
  worker.send({ kind: "select", id: 1, axes: [], focus: null, spare: null });
  worker.init();
  worker.send({ kind: "select", id: 2, axes: [["x", [xRange(0, 6)]]], focus: null, spare: null });
  worker.send({ kind: "prepare", id: 3, axes: [["x", [xRange(0, 6)]]] });
  await Promise.resolve();
  expect(worker.replies).toEqual([
    { kind: "error", message: "The brush worker selected before it was initialized" },
    { kind: "error", message: 'Column ["x",false] was never sent' },
    { kind: "error", message: 'Column ["x",false] was never sent' },
  ]);
  worker.close();
});
