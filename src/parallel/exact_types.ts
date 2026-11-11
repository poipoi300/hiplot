import type { FinishedFrame, LineColors, LineFrame } from "./webgl";

export interface ExactRequest extends Omit<LineFrame, "axes"> {
  id: number;
  axes: readonly { column: number; x: number }[];
  columns: readonly { id: number; pixels: Float32Array }[];
  colors?: LineColors;
  order?: Uint32Array;
  drawOrder?: Uint32Array;
  selection: Uint8Array;
}

export type ExactReply =
  | { kind: "ready"; density: boolean | null }
  | { kind: "frame"; id: number; bitmap: ImageBitmap; finished: FinishedFrame }
  | { kind: "error"; message: string };
