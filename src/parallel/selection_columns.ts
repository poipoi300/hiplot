import type { FilterRange } from "../filters";
import { convert_to_categorical_input, parse_numeric } from "../lib/d3_scales";
import { type Datapoint, ParamType } from "../types";
import type { SelectionColumn } from "./selection_index";

/** Identifies the column a range brushes: its field, read as categories or as numbers. */
export function columnKey(range: FilterRange): string {
  return JSON.stringify([range.col, range.type === ParamType.CATEGORICAL]);
}

/** The column `range` brushes, read from every row. */
export function selectionColumn(
  rows: ReadonlyArray<Datapoint>,
  range: FilterRange,
): SelectionColumn {
  if (range.type === ParamType.CATEGORICAL) {
    const codes = new Int32Array(rows.length).fill(-1);
    const categories: string[] = [];
    const codeOf = new Map<string, number>();
    rows.forEach((row, index) => {
      const raw = row[range.col];
      if (raw === undefined) return;
      const category = convert_to_categorical_input(raw);
      let code = codeOf.get(category);
      if (code === undefined) {
        code = categories.length;
        codeOf.set(category, code);
        categories.push(category);
      }
      codes[index] = code;
    });
    return { kind: "categorical", codes, categories };
  }
  const values = new Float64Array(rows.length);
  const missing = new Uint8Array(rows.length);
  rows.forEach((row, index) => {
    const raw = row[range.col];
    if (raw === undefined) missing[index] = 1;
    else values[index] = parse_numeric(raw);
  });
  return { kind: "numeric", values, missing };
}
