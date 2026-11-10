import { expect, test } from "bun:test";
import type { SelectionWorkerScope } from "./selection_entry";
import type { SelectionIndexRequest, SelectionIndexResponse } from "./selection_index";

test("worker replies with original row indices and transfers every result buffer", async () => {
  const previousHandler = self.onmessage;
  const { connectSelectionWorker } = await import("./selection_entry");
  self.onmessage = previousHandler;
  const replies: SelectionIndexResponse[] = [];
  const transfers: Transferable[][] = [];
  const scope: SelectionWorkerScope = {
    onmessage: null,
    postMessage: (reply, transfer) => {
      replies.push(reply);
      transfers.push(transfer);
    },
  };
  connectSelectionWorker(scope);
  const columns: SelectionIndexRequest["column"][] = [
    { kind: "numeric", values: new Float64Array([4, 1, NaN]), missing: new Uint8Array(3) },
    { kind: "categorical", codes: new Int32Array([0, -1, 1]), categories: ["z", "a"] },
  ];
  columns.forEach((column, id) => {
    scope.onmessage?.({ data: { id, column } } as MessageEvent<SelectionIndexRequest>);
  });
  expect(replies.map(({ id }) => id)).toEqual([0, 1]);
  expect(Array.from(replies[0].index.order)).toEqual([1, 0, 2]);
  expect(Array.from(replies[1].index.order)).toEqual([2, 0]);
  expect(Array.from(replies[1].index.missing)).toEqual([1]);
  replies.forEach(({ index }, id) => {
    expect(transfers[id]).toEqual([
      index.order.buffer,
      index.missing.buffer,
      index.kind === "numeric" ? index.values.buffer : index.offsets.buffer,
    ]);
  });
});
