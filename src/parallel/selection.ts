/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { FilterRange } from "../filters";
import { ParamType } from "../types";
import { columnKey } from "./selection_columns";
import {
  type IndexInterval,
  type SelectionColumn,
  type SelectionIndex,
  type SelectionIndexRequest,
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
  /** How many of the axis's columns select each row: its groups never overlap within a column. */
  membership: Uint8Array;
  /** One bit per row, set where `membership` is not zero (see BrushMasks). */
  bits: Uint32Array;
  snapshot: Uint8Array | null;
  active: boolean;
}

/** An axis's ranges read this many columns at most: `membership` counts them in a byte. */
const MAX_AXIS_COLUMNS = 255;

interface PendingIndex {
  column: ColumnState;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Where columns are sorted: the selection worker, through a port (see connectSelectionWorker). */
export interface IndexChannel {
  post(request: SelectionIndexRequest, transfer: Transferable[]): void;
  /** Delivers every response, and the channel's failure, from now on. */
  listen(
    onResponse: (response: SelectionIndexResponse) => void,
    onFailure: (error: Error) => void,
  ): void;
  close(): void;
}

/** A selection worker's port as an index channel. */
export function portChannel(port: MessagePort): IndexChannel {
  return {
    post: (request, transfer) => port.postMessage(request, transfer),
    listen: (onResponse, onFailure) => {
      port.onmessage = ({ data }: MessageEvent<SelectionIndexResponse>) => onResponse(data);
      port.onmessageerror = () => onFailure(new Error("Selection worker returned unreadable data"));
    },
    close: () => port.close(),
  };
}

/**
 * Exact brushes over fixed, immutable rows, which it reads as columns from
 * `columnOf`. Columns are sorted once through `channel`; until a column's
 * index is ready, scanning the column remains authoritative, and without a
 * channel it always is. Warm moves touch only the symmetric difference of
 * indexed range unions.
 *
 * Each axis keeps one bit per row, and the selection is the intersection of
 * the active axes' bits. Adding or removing an axis intersects them again a
 * 32-row word at a time and writes only the flags that change, in row order;
 * a move rechecks only the rows whose bit it flipped. A first brush, which
 * deselects about every row, thus costs a pass over words instead of a
 * scattered write per row.
 *
 * `axisMask` returns a cached snapshot. `select` returns a live intersection
 * buffer, updated in place by subsequent calls, so warm moves need no O(rows)
 * copy. Copy it explicitly if a historical selection is needed.
 */
export class BrushMasks {
  private readonly columns = new Map<string, ColumnState>();
  private readonly axes = new Map<string, AxisState>();
  private readonly words: number;
  /** The valid rows' bits in the last word. */
  private readonly lastWord: number;
  /** The intersection of the active axes' bits; every row's when none is active. */
  private readonly selectedBits: Uint32Array;
  private readonly selected: Uint8Array;
  private selectedTotal: number;
  /** The axes whose bits the selection intersects, as of the last time it settled. */
  private activeAxes: AxisState[] = [];
  /**
   * Whether an axis was added or removed since the selection last settled,
   * also by a call that threw partway: the next one intersects every word.
   */
  private activeChanged = false;
  /** Rows an active axis flipped since the selection last settled; null once recombining is cheaper. */
  private flipped: number[] | null = [];
  private readonly pending = new Map<number, PendingIndex>();
  private listening = false;
  private nextId = 0;
  private disposed = false;
  private failure: Error | null = null;
  private workerWasmBytes = 0;
  private passing: { dimension: string; key: string; rows: Uint8Array } | null = null;

  get wasmMemoryBytes(): number {
    return this.workerWasmBytes;
  }

  constructor(
    readonly rowCount: number,
    private readonly columnOf: (range: FilterRange) => SelectionColumn,
    private readonly channel: IndexChannel | null,
  ) {
    this.words = Math.ceil(rowCount / 32);
    this.lastWord = rowCount % 32 === 0 ? 0xffffffff : (2 ** (rowCount % 32) - 1) >>> 0;
    this.selectedBits = new Uint32Array(this.words).fill(0xffffffff);
    if (this.words > 0) this.selectedBits[this.words - 1] = this.lastWord;
    this.selected = new Uint8Array(rowCount).fill(1);
    this.selectedTotal = rowCount;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Cannot select with disposed brush masks");
    if (this.failure !== null) throw this.failure;
  }

  private column(range: FilterRange): ColumnState {
    const key = columnKey(range);
    const cached = this.columns.get(key);
    if (cached !== undefined) return cached;
    const column = this.columnOf(range);
    const length = column.kind === "numeric" ? column.values.length : column.codes.length;
    if (length !== this.rowCount) {
      throw new Error(`Column ${key} has ${length} rows; brushes select among ${this.rowCount}`);
    }
    const state: ColumnState = { column, index: null, ready: null };
    this.columns.set(key, state);
    return state;
  }

  private listen(channel: IndexChannel): void {
    if (this.listening) return;
    this.listening = true;
    channel.listen(
      (data) => {
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
      },
      (error) => this.fail(error),
    );
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.failure = error;
    this.channel?.close();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private prepareColumn(state: ColumnState): Promise<void> {
    if (state.ready !== null) return state.ready;
    const channel = this.channel;
    if (channel === null) {
      state.ready = Promise.resolve();
      return state.ready;
    }
    this.listen(channel);
    state.ready = new Promise<void>((resolve, reject) => {
      if (this.failure !== null) throw this.failure;
      const id = ++this.nextId;
      this.pending.set(id, { column: state, resolve, reject });
      const column = state.column;
      // Keep the source arrays for the exact pending-index scan.
      if (column.kind === "numeric") {
        const values = column.values.slice();
        const missing = column.missing.slice();
        channel.post({ id, column: { ...column, values, missing } }, [
          values.buffer,
          missing.buffer,
        ]);
      } else {
        const codes = column.codes.slice();
        channel.post({ id, column: { ...column, codes } }, [codes.buffer]);
      }
    });
    // Automatic warming cannot surface an unhandled rejection. Explicit prepare
    // rejects, and later selection calls surface the same failure.
    void state.ready.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    return state.ready;
  }

  /**
   * Builds the columns these ranges brush and starts sorting them, without
   * changing any selection or waiting: an axis's first brush then skips
   * reading every row. Failures surface from the next selection.
   */
  warm(selection: AxisSelection): void {
    this.assertUsable();
    for (const range of selection) void this.prepareColumn(this.column(range));
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

  /** The rows every axis of `axes` selects, in the 32 rows of `word`. */
  private intersection(word: number, axes: ReadonlyArray<AxisState>): number {
    let bits = word === this.words - 1 ? this.lastWord : 0xffffffff;
    for (const axis of axes) bits &= axis.bits[word];
    return bits >>> 0;
  }

  /** Writes the flags of `word`'s rows that changed to `bits`. */
  private setSelectedWord(word: number, bits: number): void {
    let changed = (bits ^ this.selectedBits[word]) >>> 0;
    if (changed === 0) return;
    this.selectedBits[word] = bits;
    const base = word * 32;
    while (changed !== 0) {
      const bit = 31 - Math.clz32(changed & -changed);
      const selected = (bits >>> bit) & 1;
      this.selectedTotal += selected - this.selected[base + bit];
      this.selected[base + bit] = selected;
      changed = (changed & (changed - 1)) >>> 0;
    }
  }

  /** Intersects the active axes again, after one was added or removed. */
  private recombine(): void {
    for (let word = 0; word < this.words; ++word) {
      this.setSelectedWord(word, this.intersection(word, this.activeAxes));
    }
  }

  /**
   * Brings the selection up to the axes' bits: intersects every word again
   * after an axis was added or removed, else rechecks the rows active axes
   * flipped.
   */
  private settle(): void {
    const flipped = this.flipped;
    this.flipped = [];
    if (this.activeChanged || flipped === null) {
      this.activeAxes = Array.from(this.axes.values()).filter((axis) => axis.active);
      this.activeChanged = false;
      this.recombine();
      return;
    }
    for (const row of flipped) this.recheck(row);
  }

  /** Sets `row`'s flag from the active axes' bits. */
  private recheck(row: number): void {
    const word = row >>> 5;
    const bit = 1 << (row & 31);
    let selected = 1;
    for (const axis of this.activeAxes) {
      if ((axis.bits[word] & bit) === 0) {
        selected = 0;
        break;
      }
    }
    if (selected === this.selected[row]) return;
    this.selected[row] = selected;
    this.selectedTotal += selected === 1 ? 1 : -1;
    this.selectedBits[word] ^= bit;
  }

  private flip(row: number): void {
    const flipped = this.flipped;
    if (flipped === null) return;
    // Past one flipped row per word, intersecting every word costs less than rechecking rows.
    if (flipped.length >= this.words) this.flipped = null;
    else flipped.push(row);
  }

  /** Rows the live mask `select` returns holds, counted as its flags change. */
  /** The live mask's bits, 32 rows a word, updated in place like it: read, never written. */
  get selectionBits(): Uint32Array {
    return this.selectedBits;
  }

  get selectedCount(): number {
    return this.selectedTotal;
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
        membership: new Uint8Array(this.rowCount),
        bits: new Uint32Array(this.words),
        snapshot: null,
        active: false,
      };
      this.axes.set(dimension, axis);
    }
    const current = axis;
    const groups = this.groups(selection);
    if (groups.size > MAX_AXIS_COLUMNS) {
      throw new Error(`Brushes of one axis read at most ${MAX_AXIS_COLUMNS} columns`);
    }
    const change = (row: number, included: boolean) => {
      const wasSelected = current.membership[row] !== 0;
      current.membership[row] += included ? 1 : -1;
      if (wasSelected === (current.membership[row] !== 0)) return;
      current.bits[row >>> 5] ^= 1 << (row & 31);
      if (current.active) this.flip(row);
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
        for (let row = 0; row < this.rowCount; ++row) {
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
    this.settle();
    axis.snapshot ??= this.expand((word) => axis.bits[word]);
    return axis.snapshot;
  }

  /** One flag per row from the bits `wordAt` returns for each word. */
  private expand(wordAt: (word: number) => number): Uint8Array {
    const rows = new Uint8Array(this.rowCount);
    for (let word = 0; word < this.words; ++word) {
      const bits = wordAt(word);
      if (bits === 0) continue;
      const base = word * 32;
      const end = Math.min(32, this.rowCount - base);
      for (let bit = 0; bit < end; ++bit) rows[base + bit] = (bits >>> bit) & 1;
    }
    return rows;
  }

  /** Live mask of rows inside every active axis, in original row order. */
  select(selections: ReadonlyMap<string, AxisSelection>): Uint8Array {
    this.assertUsable();
    for (const [dimension, axis] of this.axes) {
      if (!axis.active || selections.has(dimension)) continue;
      axis.active = false;
      this.activeChanged = true;
    }
    for (const [dimension, selection] of selections) {
      const axis = this.updateAxis(dimension, selection);
      if (axis.active) continue;
      axis.active = true;
      this.activeChanged = true;
    }
    this.settle();
    return this.selected;
  }

  /**
   * Flags of the rows inside the brushes of every active axis but `dimension`,
   * as of the last `select`. Asked again for the same axis, it returns the
   * same array until the other axes' brushes change: brushing `dimension`
   * alone keeps it. Asking for another axis replaces it.
   */
  passingExcept(dimension: string): Uint8Array {
    this.assertUsable();
    const others = JSON.stringify(
      Array.from(this.axes)
        .filter(([name, axis]) => name !== dimension && axis.active)
        .map(([name, axis]) => [name, axis.key]),
    );
    if (this.passing?.dimension === dimension && this.passing.key === others) {
      return this.passing.rows;
    }
    this.settle();
    const axes = this.activeAxes.filter((axis) => axis !== this.axes.get(dimension));
    const rows = this.expand((word) => this.intersection(word, axes));
    this.passing = { dimension, key: others, rows };
    return rows;
  }

  /** Releases the index channel and column/axis caches on unmount or row replacement. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel?.close();
    for (const pending of this.pending.values()) pending.resolve();
    this.pending.clear();
    this.axes.clear();
    this.columns.clear();
  }
}
