import {
  buildSelectionIndex,
  type SelectionIndexRequest,
  type SelectionIndexResponse,
} from "./selection_index";

export interface SelectionWorkerScope {
  onmessage: ((event: MessageEvent<SelectionIndexRequest>) => void) | null;
  postMessage: (message: SelectionIndexResponse, transfer: Transferable[]) => void;
}

export function connectSelectionWorker(scope: SelectionWorkerScope): void {
  scope.onmessage = ({ data }) => {
    const index = buildSelectionIndex(data.column);
    const transfer: Transferable[] = [index.order.buffer, index.missing.buffer];
    if (index.kind === "numeric") transfer.push(index.values.buffer);
    else transfer.push(index.offsets.buffer);
    scope.postMessage({ id: data.id, index }, transfer);
  };
}

connectSelectionWorker(self as unknown as SelectionWorkerScope);
