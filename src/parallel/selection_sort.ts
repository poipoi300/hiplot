import { rustKernels } from "../wasm/kernels";
import {
  buildSelectionIndexCPU,
  type SelectionColumn,
  type SelectionIndex,
} from "./selection_index";

/**
 * Builds an exact, stable original-row permutation, with the WebAssembly
 * kernels where they compile. Called only by the selection worker; kept out
 * of selection_index so the brush worker, which only reads indexes, does not
 * embed the kernels.
 */
export function buildSelectionIndex(column: SelectionColumn): SelectionIndex {
  const kernels = rustKernels();
  if (kernels !== null) {
    return column.kind === "numeric"
      ? kernels.numericIndex(column.values, column.missing)
      : kernels.categoricalIndex(column.codes, column.categories);
  }
  return buildSelectionIndexCPU(column);
}
