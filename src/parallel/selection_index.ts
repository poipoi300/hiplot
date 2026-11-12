import type { FilterRange } from "../filters";
import { ParamType } from "../types";
import { rustKernels } from "../wasm/kernels";

export type SelectionColumn =
  | { kind: "numeric"; values: Float64Array; missing: Uint8Array }
  | { kind: "categorical"; codes: Int32Array; categories: string[] };

export type SelectionIndex =
  | {
      kind: "numeric";
      order: Uint32Array;
      missing: Uint32Array;
      values: Float64Array;
      comparable: number;
    }
  | {
      kind: "categorical";
      order: Uint32Array;
      missing: Uint32Array;
      values: string[];
      offsets: Uint32Array;
    };

/** Half-open positions in an index, not original row numbers. */
export type IndexInterval = readonly [number, number];

export interface SelectionIndexRequest {
  id: number;
  column: SelectionColumn;
}

export interface SelectionIndexResponse {
  id: number;
  index: SelectionIndex;
  wasmMemoryBytes?: number;
}

/** Builds an exact, stable original-row permutation. Called only by the inline worker. */
export function buildSelectionIndex(column: SelectionColumn): SelectionIndex {
  const kernels = rustKernels();
  if (kernels !== null) {
    return column.kind === "numeric"
      ? kernels.numericIndex(column.values, column.missing)
      : kernels.categoricalIndex(column.codes, column.categories);
  }
  return buildSelectionIndexCPU(column);
}

/** JavaScript reference and fallback when WebAssembly compilation is unavailable. */
export function buildSelectionIndexCPU(column: SelectionColumn): SelectionIndex {
  const length = column.kind === "numeric" ? column.values.length : column.codes.length;
  const present: number[] = [];
  const absent: number[] = [];
  for (let row = 0; row < length; ++row) {
    if (column.kind === "numeric" ? column.missing[row] === 0 : column.codes[row] !== -1) {
      present.push(row);
    } else absent.push(row);
  }
  const order = Uint32Array.from(present);
  const missing = Uint32Array.from(absent);
  if (column.kind === "numeric") {
    const source = column.values;
    order.sort((a, b) => {
      const x = source[a];
      const y = source[b];
      if (Number.isNaN(x)) return Number.isNaN(y) ? a - b : 1;
      if (Number.isNaN(y)) return -1;
      return x < y ? -1 : x > y ? 1 : a - b;
    });
    const values = Float64Array.from(order, (row) => source[row]);
    let comparable = values.length;
    while (comparable > 0 && Number.isNaN(values[comparable - 1])) --comparable;
    return { kind: "numeric", order, missing, values, comparable };
  }
  const { codes, categories } = column;
  order.sort((a, b) => {
    const x = categories[codes[a]];
    const y = categories[codes[b]];
    return x < y ? -1 : x > y ? 1 : a - b;
  });
  const values: string[] = [];
  const starts: number[] = [];
  for (let position = 0; position < order.length; ++position) {
    const value = categories[codes[order[position]]];
    if (values.length === 0 || value !== values[values.length - 1]) {
      values.push(value);
      starts.push(position);
    }
  }
  starts.push(order.length);
  return { kind: "categorical", order, missing, values, offsets: Uint32Array.from(starts) };
}

function bound<T extends number | string>(
  values: ArrayLike<T>,
  length: number,
  value: T,
  upper = false,
): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < value || (upper && values[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Canonical union prevents overlapping brushes from counting a row twice. */
export function unionIntervals(intervals: ReadonlyArray<IndexInterval>): IndexInterval[] {
  const sorted = intervals.filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [start, end] of sorted) {
    const previous = result[result.length - 1];
    if (previous !== undefined && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** Converts inclusive source-value ranges to a union of exact index positions. */
export function selectionIntervals(
  index: SelectionIndex,
  ranges: ReadonlyArray<FilterRange>,
): IndexInterval[] {
  const intervals: IndexInterval[] = [];
  for (const range of ranges) {
    if (index.kind === "categorical") {
      if (range.type !== ParamType.CATEGORICAL)
        throw new Error("Categorical index needs categories");
      if (range.values === undefined) {
        intervals.push([
          index.offsets[bound(index.values, index.values.length, range.min)],
          index.offsets[bound(index.values, index.values.length, range.max, true)],
        ]);
      } else {
        for (const category of range.values) {
          const position = bound(index.values, index.values.length, category);
          if (index.values[position] === category) {
            intervals.push([index.offsets[position], index.offsets[position + 1]]);
          }
        }
      }
      continue;
    }
    if (range.type === ParamType.CATEGORICAL) throw new Error("Numeric index needs numeric bounds");
    if (!Number.isNaN(range.min) && !Number.isNaN(range.max)) {
      intervals.push([
        bound(index.values, index.comparable, range.min),
        bound(index.values, index.comparable, range.max, true),
      ]);
    }
    if (range.include_infnans === true) {
      intervals.push(
        [0, bound(index.values, index.comparable, Number.NEGATIVE_INFINITY, true)],
        [bound(index.values, index.comparable, Number.POSITIVE_INFINITY), index.order.length],
      );
    }
  }
  return unionIntervals(intervals);
}

/** Visits only positions in the symmetric difference of two canonical unions. */
export function visitIntervalDifference(
  before: ReadonlyArray<IndexInterval>,
  after: ReadonlyArray<IndexInterval>,
  visit: (position: number, selected: boolean) => void,
): void {
  let a = 0;
  let b = 0;
  let inBefore = false;
  let inAfter = false;
  let position = Math.min(before[0]?.[0] ?? Infinity, after[0]?.[0] ?? Infinity);
  while (position !== Infinity) {
    if (position === before[Math.floor(a / 2)]?.[a % 2]) {
      inBefore = !inBefore;
      ++a;
    }
    if (position === after[Math.floor(b / 2)]?.[b % 2]) {
      inAfter = !inAfter;
      ++b;
    }
    const next = Math.min(
      before[Math.floor(a / 2)]?.[a % 2] ?? Infinity,
      after[Math.floor(b / 2)]?.[b % 2] ?? Infinity,
    );
    if (inBefore !== inAfter) {
      for (let i = position; i < next; ++i) visit(i, inAfter);
    }
    position = next;
  }
}
