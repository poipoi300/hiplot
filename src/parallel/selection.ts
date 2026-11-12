/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { FilterRange } from "../filters";
import { convert_to_categorical_input, parse_numeric } from "../lib/d3_scales";
import { type Datapoint, ParamType } from "../types";
import {
  type IndexInterval,
  type SelectionColumn,
  type SelectionIndex,
  type SelectionIndexResponse,
  selectionIntervals,
  visitIntervalDifference,
} from "./selection_index";

/** The union of an axis's ranges; an empty list selects nothing. */
export type AxisSelection = ReadonlyArray<FilterRange>;

interface ColumnState {
  column: SelectionColumn;
  index: SelectionIndex | null;
  ready: Promise<void> | null;
}

interface RangeGroup {
  column: ColumnState;
  ranges: FilterRange[];
  intervals: IndexInterval[] | null;
}

interface AxisState {
  key: string;
  groups: Map<ColumnState, RangeGroup>;
  membership: Uint32Array;
  mask: Uint8Array;
  snapshot: Uint8Array | null;
  active: boolean;
}

interface PendingIndex {
  column: ColumnState;
  resolve: () => void;
  reject: (error: Error) => void;
}

async function inlineWorker(): Promise<Worker | null> {
  if (typeof Worker === "undefined") return null;
  // The worker is embedded in standalone HTML, never fetched from a sibling file.
  const { default: InlineWorker } = await import("./selection_entry?worker&inline");
  return new InlineWorker();
}

/**
 * Exact brushes over fixed, immutable rows. Columns are sorted once in an inline
 * worker; until ready, the original column scan remains authoritative. Warm
 * moves touch only the symmetric difference of indexed range unions.
 *
 * `axisMask` returns a cached snapshot. `select` returns a live intersection
 * buffer, updated in place by subsequent calls, so warm moves need no O(rows)
 * copy. Copy it explicitly if a historical selection is needed.
 */
export class BrushMasks {
  readonly rows: ReadonlyArray<Datapoint>;
  private readonly columns = new Map<string, ColumnState>();
  private readonly axes = new Map<string, AxisState>();
  private readonly failures: Uint32Array;
  private readonly selected: Uint8Array;
  private readonly pending = new Map<number, PendingIndex>();
  private worker: Promise<Worker | null> | null = null;
  private connected: Worker | null = null;
  private nextId = 0;
  private disposed = false;
  private failure: Error | null = null;
  private workerWasmBytes = 0;

  get wasmMemoryBytes(): number {
    return this.workerWasmBytes;
  }

  constructor(
    rows: ReadonlyArray<Datapoint>,
    private readonly createWorker: () => Promise<Worker | null> = inlineWorker,
  ) {
    this.rows = rows;
    this.failures = new Uint32Array(rows.length);
    this.selected = new Uint8Array(rows.length).fill(1);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Cannot select with disposed brush masks");
    if (this.failure !== null) throw this.failure;
  }

  private column(range: FilterRange): ColumnState {
    const categorical = range.type === ParamType.CATEGORICAL;
    const key = JSON.stringify([range.col, categorical]);
    const cached = this.columns.get(key);
    if (cached !== undefined) return cached;
    let column: SelectionColumn;
    if (categorical) {
      const codes = new Int32Array(this.rows.length).fill(-1);
      const categories: string[] = [];
      const codeOf = new Map<string, number>();
      this.rows.forEach((row, index) => {
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
      column = { kind: "categorical", codes, categories };
    } else {
      const values = new Float64Array(this.rows.length);
      const missing = new Uint8Array(this.rows.length);
      this.rows.forEach((row, index) => {
        const raw = row[range.col];
        if (raw === undefined) missing[index] = 1;
        else values[index] = parse_numeric(raw);
      });
      column = { kind: "numeric", values, missing };
    }
    const state: ColumnState = { column, index: null, ready: null };
    this.columns.set(key, state);
    return state;
  }

  private connect(): Promise<Worker | null> {
    if (this.worker !== null) return this.worker;
    this.worker = this.createWorker().then((worker) => {
      if (this.disposed) {
        worker?.terminate();
        return null;
      }
      if (worker === null) return null;
      this.connected = worker;
      worker.onmessage = ({ data }: MessageEvent<SelectionIndexResponse>) => {
        if (this.disposed) return;
        const pending = this.pending.get(data.id);
        if (pending === undefined) {
          this.fail(new Error("Selection worker returned an unexpected column"));
          return;
        }
        this.pending.delete(data.id);
        pending.column.index = data.index;
        this.workerWasmBytes = data.wasmMemoryBytes ?? 0;
        pending.resolve();
      };
      worker.onerror = (event) => this.fail(new Error(`Selection worker failed: ${event.message}`));
      worker.onmessageerror = () =>
        this.fail(new Error("Selection worker returned unreadable data"));
      return worker;
    });
    return this.worker;
  }

  private fail(error: Error): void {
    this.failure = error;
    this.connected?.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private prepareColumn(state: ColumnState): Promise<void> {
    if (state.ready !== null) return state.ready;
    state.ready = this.connect().then((worker) => {
      if (worker === null || this.disposed) return;
      if (this.failure !== null) throw this.failure;
      return new Promise<void>((resolve, reject) => {
        const id = ++this.nextId;
        this.pending.set(id, { column: state, resolve, reject });
        const column = state.column;
        // Keep the source arrays for the exact pending-index scan.
        if (column.kind === "numeric") {
          const values = column.values.slice();
          const missing = column.missing.slice();
          worker.postMessage({ id, column: { ...column, values, missing } }, [
            values.buffer,
            missing.buffer,
          ]);
        } else {
          const codes = column.codes.slice();
          worker.postMessage({ id, column: { ...column, codes } }, [codes.buffer]);
        }
      });
    });
    // Automatic warming cannot surface an unhandled rejection. Explicit prepare
    // rejects, and later selection calls surface the same failure.
    void state.ready.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    return state.ready;
  }

  /** Warm the columns named by these ranges, without changing any selection. */
  async prepare(selections: ReadonlyMap<string, AxisSelection>): Promise<void> {
    this.assertUsable();
    await Promise.all(
      Array.from(selections.values()).flatMap((ranges) =>
        ranges.map((range) => this.prepareColumn(this.column(range))),
      ),
    );
  }

  private groups(selection: AxisSelection): Map<ColumnState, RangeGroup> {
    const groups = new Map<ColumnState, RangeGroup>();
    for (const range of selection) {
      const column = this.column(range);
      void this.prepareColumn(column);
      let group = groups.get(column);
      if (group === undefined) {
        group = { column, ranges: [], intervals: null };
        groups.set(column, group);
      }
      group.ranges.push(
        range.type === ParamType.CATEGORICAL && range.values !== undefined
          ? { ...range, values: range.values.slice() }
          : { ...range },
      );
    }
    for (const group of groups.values()) {
      if (group.column.index !== null) {
        group.intervals = selectionIntervals(group.column.index, group.ranges);
      }
    }
    return groups;
  }

  private scanGroup(group: RangeGroup | undefined): (row: number) => boolean {
    if (group === undefined) return () => false;
    const column = group.column.column;
    if (column.kind === "categorical") {
      const accepted = new Uint8Array(column.categories.length);
      for (const range of group.ranges) {
        if (range.type !== ParamType.CATEGORICAL) throw new Error("Expected categorical range");
        const values = range.values === undefined ? null : new Set(range.values);
        column.categories.forEach((category, code) => {
          if (
            values === null ? range.min <= category && category <= range.max : values.has(category)
          ) {
            accepted[code] = 1;
          }
        });
      }
      return (row) => column.codes[row] !== -1 && accepted[column.codes[row]] === 1;
    }
    return (row) => {
      if (column.missing[row] !== 0) return false;
      const value = column.values[row];
      return group.ranges.some((range) => {
        if (range.type === ParamType.CATEGORICAL) throw new Error("Expected numeric range");
        return (
          (range.min <= value && value <= range.max) ||
          (range.include_infnans === true && !Number.isFinite(value))
        );
      });
    };
  }

  private changeFailure(row: number, delta: number): void {
    this.failures[row] += delta;
    this.selected[row] = Number(this.failures[row] === 0);
  }

  private updateAxis(dimension: string, selection: AxisSelection): AxisState {
    // JSON's default NaN/Infinity -> null conversion would alias distinct bounds.
    const key = JSON.stringify(selection, (_, value) =>
      typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
    );
    let axis = this.axes.get(dimension);
    if (axis !== undefined && axis.key === key) return axis;
    if (axis === undefined) {
      axis = {
        key: "",
        groups: new Map(),
        membership: new Uint32Array(this.rows.length),
        mask: new Uint8Array(this.rows.length),
        snapshot: null,
        active: false,
      };
      this.axes.set(dimension, axis);
    }
    const current = axis;
    const groups = this.groups(selection);
    const change = (row: number, included: boolean) => {
      const wasSelected = current.membership[row] !== 0;
      current.membership[row] += included ? 1 : -1;
      const selected = current.membership[row] !== 0;
      if (wasSelected === selected) return;
      current.mask[row] = Number(selected);
      if (current.active) this.changeFailure(row, selected ? -1 : 1);
    };
    for (const column of new Set([...axis.groups.keys(), ...groups.keys()])) {
      const before = axis.groups.get(column);
      const after = groups.get(column);
      const index = column.index;
      if (index !== null) {
        const oldIntervals = before?.intervals ?? selectionIntervals(index, before?.ranges ?? []);
        const newIntervals = after?.intervals ?? [];
        visitIntervalDifference(oldIntervals, newIntervals, (position, selected) =>
          change(index.order[position], selected),
        );
      } else {
        const wasSelected = this.scanGroup(before);
        const isSelected = this.scanGroup(after);
        for (let row = 0; row < this.rows.length; ++row) {
          const oldValue = wasSelected(row);
          const newValue = isSelected(row);
          if (oldValue !== newValue) change(row, newValue);
        }
      }
    }
    axis.groups = groups;
    axis.key = key;
    axis.snapshot = null;
    return axis;
  }

  /** Snapshot of the rows in any range on this axis; unchanged ranges reuse it. */
  axisMask(dimension: string, selection: AxisSelection): Uint8Array {
    this.assertUsable();
    const axis = this.updateAxis(dimension, selection);
    axis.snapshot ??= axis.mask.slice();
    return axis.snapshot;
  }

  private visitRejected(axis: AxisState, delta: number): void {
    // Every rejected row is outside each group's union. Use the broadest ready
    // union to enumerate a superset of rejected rows, including undefined cells.
    let candidate: { index: SelectionIndex; intervals: IndexInterval[] } | null = null;
    let covered = -1;
    for (const group of axis.groups.values()) {
      const index = group.column.index;
      if (index === null) continue;
      const intervals = group.intervals ?? selectionIntervals(index, group.ranges);
      const count = intervals.reduce((total, [start, end]) => total + end - start, 0);
      if (count > covered) {
        candidate = { index, intervals };
        covered = count;
      }
    }
    const visit = (row: number) => {
      if (axis.mask[row] === 0) this.changeFailure(row, delta);
    };
    if (candidate === null) {
      for (let row = 0; row < axis.mask.length; ++row) visit(row);
      return;
    }
    const { index, intervals } = candidate;
    let start = 0;
    for (const [low, high] of intervals) {
      for (let position = start; position < low; ++position) visit(index.order[position]);
      start = high;
    }
    for (let position = start; position < index.order.length; ++position)
      visit(index.order[position]);
    for (const row of index.missing) visit(row);
  }

  /** Live mask of rows inside every active axis, in original row order. */
  select(selections: ReadonlyMap<string, AxisSelection>): Uint8Array {
    this.assertUsable();
    for (const [dimension, axis] of this.axes) {
      if (!axis.active || selections.has(dimension)) continue;
      axis.active = false;
      this.visitRejected(axis, -1);
    }
    for (const [dimension, selection] of selections) {
      const axis = this.updateAxis(dimension, selection);
      if (axis.active) continue;
      axis.active = true;
      this.visitRejected(axis, 1);
    }
    return this.selected;
  }

  /** The selected rows, in their original order. Materializing rows is O(rows). */
  selectedRows(selected: Uint8Array): Datapoint[] {
    return this.rows.filter((_, index) => selected[index] === 1);
  }

  /** Release the worker and column/axis caches on unmount or row replacement. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connected?.terminate();
    this.connected = null;
    for (const pending of this.pending.values()) pending.resolve();
    this.pending.clear();
    this.axes.clear();
    this.columns.clear();
  }
}
