import { rustMemoryBytes } from "../wasm/kernels";
import type { SelectionIndexRequest, SelectionIndexResponse } from "./selection_index";
import { buildSelectionIndex } from "./selection_sort";

/** The brush worker's end of the channel it sorts columns through. */
export interface SelectionIndexPort {
  onmessage: ((event: MessageEvent<SelectionIndexRequest>) => void) | null;
  postMessage: (message: SelectionIndexResponse, transfer: Transferable[]) => void;
}

export interface SelectionWorkerScope {
  onmessage: ((event: MessageEvent<{ port: SelectionIndexPort }>) => void) | null;
}

/**
 * Sorts the columns the brush worker sends through the port it is given: in
 * a worker of its own, so a sort never delays a brush's selection.
 */
export function connectSelectionWorker(scope: SelectionWorkerScope): void {
  scope.onmessage = ({ data: { port } }) => {
    port.onmessage = ({ data }) => {
      const index = buildSelectionIndex(data.column);
      const transfer: Transferable[] = [index.order.buffer, index.missing.buffer];
      if (index.kind === "numeric") transfer.push(index.values.buffer);
      else transfer.push(index.offsets.buffer);
      port.postMessage({ id: data.id, index, wasmMemoryBytes: rustMemoryBytes() }, transfer);
    };
  };
}

connectSelectionWorker(self as unknown as SelectionWorkerScope);
