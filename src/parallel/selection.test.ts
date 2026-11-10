import { describe, expect, spyOn, test } from "bun:test";
import { anyOfRanges, apply_filters, type FilterRange } from "../filters";
import { type Datapoint, ParamType } from "../types";
import { type AxisSelection, BrushMasks } from "./selection";
import {
  buildSelectionIndex,
  type SelectionIndexRequest,
  type SelectionIndexResponse,
} from "./selection_index";

const rows: Datapoint[] = [
  { uid: "0", from_uid: null, x: 1, c: "a" },
  { uid: "1", from_uid: null, x: "5", c: "b" },
  { uid: "2", from_uid: null, x: "inf", c: "" },
  { uid: "3", from_uid: null, x: Number.NaN, c: "c" },
  { uid: "4", from_uid: null, c: "b" },
  { uid: "5", from_uid: null, x: 9, c: 10 },
];
const uids = (selected: Datapoint[]) => selected.map((row) => row.uid);

function select(masks: BrushMasks, selections: [string, AxisSelection][]): string[] {
  return uids(masks.selectedRows(masks.select(new Map(selections))));
}

const xRange = (min: number, max: number, include_infnans = false): FilterRange => ({
  col: "x",
  type: ParamType.NUMERIC,
  min,
  max,
  include_infnans,
});
const cRange = (min: string, max: string): FilterRange => ({
  col: "c",
  type: ParamType.CATEGORICAL,
  min,
  max,
});
const cValues = (values: string[]): FilterRange => ({
  col: "c",
  type: ParamType.CATEGORICAL,
  min: values[0],
  max: values[values.length - 1],
  values,
});

describe("brush masks", () => {
  test("numeric ranges parse values and never select missing ones", () => {
    expect(select(new BrushMasks(rows), [["x", [xRange(0, 6)]]])).toEqual(["0", "1"]);
  });

  test("numeric ranges can include inf and nan values", () => {
    expect(select(new BrushMasks(rows), [["x", [xRange(4, 6, true)]]])).toEqual(["1", "2", "3"]);
  });

  test("categorical ranges without values compare category strings, with (empty) for empty strings", () => {
    expect(select(new BrushMasks(rows), [["c", [cRange("(empty)", "b")]]])).toEqual([
      "0",
      "1",
      "2",
      "4",
      "5",
    ]);
  });

  test("categorical ranges with values select exactly those categories", () => {
    // "10" sorts before "b" as a string, but is not one of the brushed categories.
    expect(select(new BrushMasks(rows), [["c", [cValues(["a", "b"])]]])).toEqual(["0", "1", "4"]);
  });

  test("an axis whose brushes select no value selects nothing", () => {
    expect(select(new BrushMasks(rows), [["c", []]])).toEqual([]);
  });

  test("the ranges of one axis select the rows in any of them", () => {
    const masks = new BrushMasks(rows);
    expect(select(masks, [["x", [xRange(0, 2), xRange(8, 10)]]])).toEqual(["0", "5"]);
    expect(select(masks, [["c", [cValues(["a"]), cValues(["c", "10"])]]])).toEqual(["0", "3", "5"]);
    // Overlapping ranges count each row once.
    expect(select(masks, [["x", [xRange(0, 6), xRange(4, 10, true)]]])).toEqual([
      "0",
      "1",
      "2",
      "3",
      "5",
    ]);
  });

  test("brushes on several axes intersect, and no brush selects everything", () => {
    const masks = new BrushMasks(rows);
    expect(select(masks, [])).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(
      select(masks, [
        ["x", [xRange(0, 10)]],
        ["c", [cRange("b", "c")]],
      ]),
    ).toEqual(["1"]);
    expect(
      select(masks, [
        ["x", [xRange(0, 2), xRange(8, 10)]],
        ["c", [cValues(["10"]), cValues(["b"])]],
      ]),
    ).toEqual(["5"]);
  });

  test("only the axis whose ranges changed computes its mask again", () => {
    const masks = new BrushMasks(rows);
    const first = masks.axisMask("x", [xRange(0, 6)]);
    const other = masks.axisMask("c", [cValues(["a"])]);
    expect(masks.axisMask("x", [xRange(0, 6)])).toBe(first);
    expect(masks.axisMask("x", [xRange(0, 6), xRange(8, 9)])).not.toBe(first);
    expect(masks.axisMask("c", [cValues(["a"])])).toBe(other);
  });

  test("masks select exactly the rows the equivalent filters keep", () => {
    const selections: [string, AxisSelection][] = [
      ["x", [xRange(0, 2, true), xRange(8, 9)]],
      ["c", [cRange("10", "b"), cValues(["c"])]],
    ];
    const filters = selections.map(([, selection]) => anyOfRanges(selection));
    expect(select(new BrushMasks(rows), selections)).toEqual(uids(apply_filters(rows, filters)));
    expect(select(new BrushMasks(rows), [["c", []]])).toEqual(
      uids(apply_filters(rows, [anyOfRanges([])])),
    );
  });
});

class TestWorker {
  onmessage: ((event: MessageEvent<SelectionIndexResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: SelectionIndexRequest[] = [];
  terminated = false;
  autoReply = false;
  private requestPosted: (() => void) | null = null;
  readonly requested = new Promise<void>((resolve) => {
    this.requestPosted = resolve;
  });

  postMessage(request: SelectionIndexRequest): void {
    this.requests.push(request);
    this.requestPosted?.();
    if (this.autoReply) {
      queueMicrotask(() =>
        this.onmessage?.({
          data: { id: request.id, index: buildSelectionIndex(request.column) },
        } as MessageEvent<SelectionIndexResponse>),
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function warm(
  masks: BrushMasks,
  worker: TestWorker,
  selections: [string, AxisSelection][],
): Promise<void> {
  worker.autoReply = true;
  await masks.prepare(new Map(selections));
}

describe("incremental indexed brushes", () => {
  test("pending scans transition to indices without sorting or rereading source rows on warm moves", async () => {
    let reads = 0;
    const source = Array.from(
      { length: 1000 },
      (_, index): Datapoint => ({
        uid: String(index),
        from_uid: null,
        get x() {
          ++reads;
          return index;
        },
      }),
    );
    const worker = new TestWorker();
    const masks = new BrushMasks(source, async () => worker as unknown as Worker);
    const ranges: [string, AxisSelection][] = [["x", [xRange(100, 900)]]];
    expect(select(masks, ranges)).toHaveLength(801);
    expect(worker.requests).toHaveLength(0);
    await warm(masks, worker, ranges);
    expect(worker.requests).toHaveLength(1);
    const readCount = reads;
    const sort = spyOn(Uint32Array.prototype, "sort");
    const buffer = masks.select(new Map(ranges));
    for (let i = 0; i < 20; ++i) {
      expect(masks.select(new Map([["x", [xRange(101 + i, 900)]]]))).toBe(buffer);
      expect(buffer[100 + i]).toBe(0);
      expect(buffer[101 + i]).toBe(1);
    }
    expect(reads).toBe(readCount);
    expect(sort).not.toHaveBeenCalled();
    sort.mockRestore();
    expect(worker.requests).toHaveLength(1);
    masks.dispose();
    expect(worker.terminated).toBe(true);
  });

  test("intersection updates only changed candidates for moves, overlaps, added axes and removals", async () => {
    const source = Array.from(
      { length: 10_000 },
      (_, i): Datapoint => ({
        uid: String(i),
        from_uid: null,
        x: i,
        y: i,
      }),
    );
    const worker = new TestWorker();
    const masks = new BrushMasks(source, async () => worker as unknown as Worker);
    const full = [xRange(0, 9999)];
    const y = [{ ...xRange(1, 9999), col: "y" }];
    await warm(masks, worker, [
      ["x", full],
      ["y", y],
    ]);
    masks.select(new Map([["x", full]]));
    const changes = spyOn(
      masks as unknown as { changeFailure(row: number, delta: number): void },
      "changeFailure",
    );
    masks.select(new Map([["x", [xRange(1, 9999)]]]));
    expect(changes.mock.calls).toEqual([[0, 1]]);
    changes.mockClear();
    masks.select(new Map([["x", [xRange(1, 7000), xRange(6000, 9999)]]]));
    expect(changes).not.toHaveBeenCalled();
    masks.select(
      new Map([
        ["x", [xRange(1, 9999)]],
        ["y", y],
      ]),
    );
    expect(changes.mock.calls).toEqual([[0, 1]]);
    changes.mockClear();
    masks.select(new Map([["y", y]]));
    expect(changes.mock.calls).toEqual([[0, -1]]);
    changes.mockClear();
    const selected = masks.select(new Map());
    expect(changes.mock.calls).toEqual([[0, -1]]);
    expect(selected.every((value) => value === 1)).toBe(true);
    changes.mockRestore();
    masks.dispose();
  });

  test("numeric cache keys distinguish NaN and both infinite bounds", async () => {
    const worker = new TestWorker();
    const masks = new BrushMasks(rows, async () => worker as unknown as Worker);
    await warm(masks, worker, [["x", [xRange(0, 1)]]]);
    expect(select(masks, [["x", [xRange(NaN, Infinity)]]])).toEqual([]);
    expect(select(masks, [["x", [xRange(-Infinity, Infinity)]]])).toEqual(["0", "1", "2", "5"]);
    expect(select(masks, [["x", [xRange(Infinity, Infinity)]]])).toEqual(["2"]);
    masks.dispose();
  });

  test("snapshots survive warm deltas, and mutated range objects do not rewrite prior membership", async () => {
    const worker = new TestWorker();
    const masks = new BrushMasks(rows, async () => worker as unknown as Worker);
    const range = xRange(0, 6);
    await warm(masks, worker, [["x", [range]]]);
    const snapshot = masks.axisMask("x", [range]);
    expect(select(masks, [["x", [range]]])).toEqual(["0", "1"]);
    range.min = 4;
    expect(select(masks, [["x", [range]]])).toEqual(["1"]);
    expect(Array.from(snapshot)).toEqual([1, 1, 0, 0, 0, 0]);
    masks.dispose();
  });

  test("random unions, axes added and removed, type changes and clears match filters in original row order", async () => {
    let seed = 15231;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const specials = [
      undefined,
      null,
      NaN,
      Infinity,
      -Infinity,
      "inf",
      "",
      false,
      "1.0000000000000002",
    ];
    const source: Datapoint[] = Array.from({ length: 250 }, (_, i) => ({
      uid: `row-${250 - i}`,
      from_uid: null,
      x: i % 3 === 0 ? specials[i % specials.length] : (random() - 0.5) * 20,
      y: i % 5 === 0 ? undefined : String(Math.floor(random() * 20)),
      c: i % 7 === 0 ? undefined : ["b", "10", "2", "", null, false][i % 6],
    }));
    const worker = new TestWorker();
    const masks = new BrushMasks(source, async () => worker as unknown as Worker);
    const scanning = new BrushMasks(source, async () => null);
    await warm(masks, worker, [
      ["x", [xRange(0, 1)]],
      ["c", [cRange("", "z")]],
      ["y", [{ ...xRange(0, 1), col: "y" }]],
      ["x-category", [{ ...cRange("", "z"), col: "x" }]],
    ]);
    for (let iteration = 0; iteration < 160; ++iteration) {
      const selections = new Map<string, AxisSelection>();
      for (const col of ["x", "y", "c"]) {
        if (random() < 0.25) continue;
        const ranges: FilterRange[] = [];
        const count = Math.floor(random() * 4);
        for (let j = 0; j < count; ++j) {
          if (col === "c" || (col === "x" && iteration % 9 === 0)) {
            ranges.push({
              ...cRange("(empty)", "b"),
              col,
              ...(random() < 0.5
                ? { values: ["10", "b", "null", "false"].filter(() => random() < 0.5) }
                : {}),
            });
          } else {
            const a = (random() - 0.5) * 30;
            const b = (random() - 0.5) * 30;
            ranges.push({ ...xRange(Math.min(a, b), Math.max(a, b), random() < 0.4), col });
          }
        }
        selections.set(col, ranges);
      }
      if (iteration % 11 === 0) selections.clear();
      if (iteration % 13 === 0) selections.set("mixed", [xRange(-2, 3), cValues(["b", "10"])]);
      const expected = apply_filters(source, Array.from(selections.values(), anyOfRanges));
      expect(uids(masks.selectedRows(masks.select(selections)))).toEqual(uids(expected));
      expect(uids(scanning.selectedRows(scanning.select(selections)))).toEqual(uids(expected));
      for (const [axis, ranges] of selections) {
        expect(uids(masks.selectedRows(masks.axisMask(axis, ranges)))).toEqual(
          uids(apply_filters(source, [anyOfRanges(ranges)])),
        );
      }
    }
    expect(worker.requests).toHaveLength(4);
    masks.dispose();
    scanning.dispose();
  });

  test("dispose releases pending preparation and prevents reuse, including delayed connection", async () => {
    const worker = new TestWorker();
    const masks = new BrushMasks(rows, async () => worker as unknown as Worker);
    const prepared = masks.prepare(new Map([["x", [xRange(0, 6)]]]));
    await worker.requested;
    masks.dispose();
    await prepared;
    masks.dispose();
    expect(worker.terminated).toBe(true);
    expect(() => masks.select(new Map())).toThrow("disposed");
    expect(() => masks.axisMask("x", [])).toThrow("disposed");
    const late = new TestWorker();
    let connect: ((worker: Worker) => void) | undefined;
    const delayed = new BrushMasks(
      rows,
      () =>
        new Promise((resolve) => {
          connect = resolve;
        }),
    );
    const ready = delayed.prepare(new Map([["x", [xRange(0, 6)]]]));
    delayed.dispose();
    connect?.(late as unknown as Worker);
    await ready;
    expect(late.terminated).toBe(true);
    expect(late.requests).toHaveLength(0);
  });

  test("worker failures reject preparation and surface on later selection", async () => {
    const worker = new TestWorker();
    const masks = new BrushMasks(rows, async () => worker as unknown as Worker);
    const ready = masks.prepare(new Map([["x", [xRange(0, 6)]]]));
    await worker.requested;
    worker.onerror?.({ message: "failed" } as ErrorEvent);
    await expect(ready).rejects.toThrow("Selection worker failed: failed");
    expect(() => masks.select(new Map())).toThrow("failed");
    masks.dispose();
  });
});
