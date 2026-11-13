import type { FinishedFrame, LineColors, LineFocus, LineFrame } from "./webgl";

export interface ExactRequest extends Omit<LineFrame, "axes"> {
  id: number;
  axes: readonly { column: number; x: number }[];
  columns: readonly { id: number; pixels: Float32Array }[];
  colors?: LineColors;
  order?: Uint32Array;
  drawOrder?: Uint32Array;
  selection: Uint8Array;
  /** A brush gesture's axis; its rows are sent when they change, else the worker keeps the last. */
  focus: (Omit<LineFocus, "rows"> & { rows?: LineFocus["rows"] }) | null;
}

export type ExactReply =
  | {
      kind: "ready";
      density: boolean | null;
      /** Whether brush frames can sum retained blocks: float targets on a GPU (see LineFocus). */
      blocks: boolean;
    }
  | {
      kind: "frame";
      id: number;
      bitmap: ImageBitmap;
      finished: FinishedFrame;
      /** The request's selection buffer, returned for the next request to reuse. */
      selection: Uint8Array;
    }
  | { kind: "error"; message: string };
