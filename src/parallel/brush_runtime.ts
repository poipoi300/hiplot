import type { BrushMessage, BrushReply } from "./brush_types";
import { BrushMasks, portChannel } from "./selection";
import { columnKey } from "./selection_columns";
import type { SelectionColumn } from "./selection_index";

export interface BrushWorkerScope {
  onmessage: ((event: MessageEvent<BrushMessage>) => void) | null;
  postMessage: (message: BrushReply, transfer?: Transferable[]) => void;
}

/**
 * The brush worker: it owns the brushes' selection state (see BrushMasks),
 * so a brush's first move, which flips about every row, never holds up the
 * page. The page sends each column once and then only brush ranges.
 */
export function connectBrushWorker(scope: BrushWorkerScope): void {
  const columns = new Map<string, SelectionColumn>();
  let masks: BrushMasks | null = null;
  let sentPassing: { focus: string; rows: Uint8Array } | null = null;
  const engine = (): BrushMasks => {
    if (masks === null) throw new Error("The brush worker selected before it was initialized");
    return masks;
  };
  const fail = (error: unknown) =>
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  scope.onmessage = ({ data }) => {
    try {
      switch (data.kind) {
        case "init":
          masks = new BrushMasks(
            data.rowCount,
            (range) => {
              const column = columns.get(columnKey(range));
              if (column === undefined)
                throw new Error(`Column ${columnKey(range)} was never sent`);
              return column;
            },
            portChannel(data.index),
          );
          return;
        case "column":
          columns.set(columnKey(data.range), data.column);
          engine().warm([data.range]);
          return;
        case "select": {
          const selected = engine();
          const live = selected.select(new Map(data.axes));
          // Buffers go back and forth with the page instead of one per move.
          const mask =
            data.spare?.length === live.length ? data.spare : new Uint8Array(live.length);
          mask.set(live);
          let passing: Uint8Array | null = null;
          if (data.focus !== null) {
            const rows = selected.passingExcept(data.focus);
            if (sentPassing?.focus !== data.focus || sentPassing.rows !== rows) {
              passing = rows.slice();
              sentPassing = { focus: data.focus, rows };
            }
          }
          const transfer: Transferable[] = [mask.buffer];
          if (passing !== null) transfer.push(passing.buffer);
          scope.postMessage(
            {
              kind: "selected",
              id: data.id,
              mask,
              count: selected.selectedCount,
              passing,
              wasmMemoryBytes: selected.wasmMemoryBytes,
            },
            transfer,
          );
          return;
        }
        case "prepare": {
          const selected = engine();
          selected.prepare(new Map(data.axes)).then(
            () =>
              scope.postMessage({
                kind: "prepared",
                id: data.id,
                wasmMemoryBytes: selected.wasmMemoryBytes,
              }),
            fail,
          );
          return;
        }
      }
    } catch (error) {
      fail(error);
    }
  };
}
