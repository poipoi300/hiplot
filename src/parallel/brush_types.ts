import type { FilterRange } from "../filters";
import type { AxisSelection } from "./selection";
import type { SelectionColumn } from "./selection_index";

/** Each brushed axis and its ranges, as `BrushMasks.select` takes them. */
export type BrushedAxes = Array<[string, AxisSelection]>;

export type BrushMessage =
  /** First: the row count, and the port of the worker that sorts columns. */
  | { kind: "init"; rowCount: number; index: MessagePort }
  /** A column brushes read, sent before any request that brushes it. */
  | { kind: "column"; range: FilterRange; column: SelectionColumn }
  /** The rows in the brushes, and those every axis but `focus` passes. */
  | {
      kind: "select";
      id: number;
      axes: BrushedAxes;
      focus: string | null;
      /** A selection buffer the page no longer reads, for this reply's selection. */
      spare: Uint8Array | null;
    }
  /** Replies once the columns these axes brush are sorted. */
  | { kind: "prepare"; id: number; axes: BrushedAxes };

export type BrushReply =
  | {
      kind: "selected";
      id: number;
      mask: Uint8Array;
      count: number;
      /** The rows every axis but the request's focus passes; null if unchanged since sent. */
      passing: Uint8Array | null;
      wasmMemoryBytes: number;
    }
  | { kind: "prepared"; id: number; wasmMemoryBytes: number }
  | { kind: "error"; message: string };
