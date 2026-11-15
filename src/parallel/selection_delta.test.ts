import { expect, test } from "bun:test";
import { DeltaSelection, selectionDelta } from "./selection_delta";

function bitsOf(flags: number[]): Uint32Array {
  const bits = new Uint32Array(Math.ceil(flags.length / 32));
  flags.forEach((flag, row) => {
    if (flag === 1) bits[row >>> 5] |= 1 << (row & 31);
  });
  return bits;
}

test("deltas carry only changed words while those take less room than every word", () => {
  const rows = 32 * 8;
  const before = Array.from({ length: rows }, (_, row) => row % 3 === 0);
  const previous = bitsOf(before.map(Number));
  // Rows 31 and 32 straddle a word edge, and row 31 is a word's sign bit.
  const after = before.map((flag, row) => (row === 31 || row === 32 ? !flag : flag));
  const delta = selectionDelta(previous, bitsOf(after.map(Number)), {
    link: 1,
    version: 4,
    rowCount: rows,
    count: 9,
  });
  expect(Array.from(delta.words ?? [])).toEqual([0, 1]);
  expect(delta.bits).toHaveLength(2);
  expect(delta).toMatchObject({ kind: "selection", version: 4, rowCount: rows, count: 9 });
  // A first selection, or one changing half the words or more, sends every word.
  const first = selectionDelta(null, previous, { link: 1, version: 1, rowCount: rows, count: 1 });
  expect(first.words).toBeNull();
  expect(first.bits).not.toBe(previous);
  expect(Array.from(first.bits)).toEqual(Array.from(previous));
  const inverted = previous.map((word) => ~word >>> 0);
  expect(
    selectionDelta(previous, inverted, { link: 1, version: 2, rowCount: rows, count: 1 }).words,
  ).toBeNull();
  expect(() =>
    selectionDelta(new Uint32Array(1), new Uint32Array(2), {
      link: 1,
      version: 1,
      rowCount: 64,
      count: 0,
    }),
  ).toThrow("different row counts");
});

test("a delta selection writes the flags of the rows its deltas change, in order", () => {
  const rows = 70;
  const selection = new DeltaSelection(1, rows);
  expect(selection.ready).toBe(false);
  const flags = Array.from({ length: rows }, (_, row) => Number(row % 2 === 0));
  let bits = bitsOf(flags);
  selection.apply(selectionDelta(null, bits, { link: 1, version: 1, rowCount: rows, count: 35 }));
  expect(selection.ready).toBe(true);
  expect(Array.from(selection.mask)).toEqual(flags);
  for (let version = 2; version < 40; ++version) {
    const row = (version * 17) % rows;
    flags[row] = 1 - flags[row];
    const next = bitsOf(flags);
    const count = flags.reduce((total, flag) => total + flag, 0);
    selection.apply(selectionDelta(bits, next, { link: 1, version, rowCount: rows, count }));
    bits = next;
    expect(Array.from(selection.mask)).toEqual(flags);
    expect(selection.count).toBe(count);
    expect(selection.version).toBe(version);
  }
});

test("delta selections refuse other row counts, stale versions and changes before a selection", () => {
  const selection = new DeltaSelection(1, 40);
  const bits = bitsOf(Array.from({ length: 40 }, () => 1));
  const changes = selectionDelta(null, bits, { link: 1, version: 1, rowCount: 40, count: 40 });
  expect(changes.words).toBeNull();
  const partial = { ...changes, words: new Uint32Array([0]), bits: new Uint32Array([1]) };
  expect(() => selection.apply(partial)).toThrow("before the selection");
  expect(() => selection.apply({ ...changes, rowCount: 41 })).toThrow("41 rows for 40 rows");
  expect(() => selection.apply({ ...changes, bits: new Uint32Array(1) })).toThrow("lacks words");
  selection.apply(changes);
  expect(() => selection.apply(changes)).toThrow("Selection 1 arrived after 1");
});

test("a delta selection holds the versions of its own link from the one it applied", () => {
  const selection = new DeltaSelection(2, 3);
  const bits = bitsOf([1, 0, 1]);
  expect(selection.holds({ link: 2, version: 1 })).toBe(false);
  selection.apply(selectionDelta(null, bits, { link: 2, version: 4, rowCount: 3, count: 2 }));
  expect(selection.holds({ link: 2, version: 4 })).toBe(true);
  expect(selection.holds({ link: 2, version: 3 })).toBe(true);
  expect(selection.holds({ link: 2, version: 5 })).toBe(false);
  expect(selection.holds({ link: 1, version: 4 })).toBe(false);
  expect(() =>
    selection.apply(selectionDelta(null, bits, { link: 1, version: 5, rowCount: 3, count: 2 })),
  ).toThrow("link 1 reached link 2");
});
