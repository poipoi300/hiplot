import { describe, expect, test } from "bun:test";
import {
  BLOCK_MEMORY_BYTES,
  BlockSelection,
  blockCountFor,
  blocksFit,
  DESELECTED_HALF,
  LAYER_CONTEXT,
  LAYER_SELECTED,
  LAYER_SKIPPED,
  MIN_BLOCK_ROWS,
  MIN_FOCUS_BLOCKS,
  PARTIAL_SLOTS,
  PartialSlots,
  partitionRows,
  SELECTED_HALF,
  type SlotPlan,
} from "./webgl_blocks";

/** A seeded linear congruential generator in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffled(rows: number, random: () => number): Uint32Array {
  const order = Uint32Array.from({ length: rows }, (_, row) => row);
  for (let i = rows - 1; i > 0; --i) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

describe("partitionRows", () => {
  const random = seeded(7);
  const rows = 2000;
  const pixels = Float32Array.from({ length: rows }, (_, row) =>
    row % 31 === 0 ? Number.NaN : row % 7 === 0 ? -0.25 * row : Math.floor(random() * 300) / 4,
  );
  const focus = Uint8Array.from({ length: rows }, (_, row) => Number(row % 5 !== 0));
  const drawOrder = shuffled(rows, random);
  const partition = partitionRows(pixels, focus, drawOrder, 9);
  const blocks = partition.starts.length - 1;

  test("puts every row in exactly one block, the unfocused ones last", () => {
    expect(Array.from(partition.order).sort((a, b) => a - b)).toEqual(
      Array.from({ length: rows }, (_, row) => row),
    );
    expect(blocks).toBe(10);
    for (let block = 0; block < blocks; ++block) {
      for (let at = partition.starts[block]; at < partition.starts[block + 1]; ++at) {
        const row = partition.order[at];
        expect(partition.blockOf[row]).toBe(block);
        expect(focus[row]).toBe(block === blocks - 1 ? 0 : 1);
      }
    }
  });

  test("ranks focus rows by pixel into near-equal blocks, missing values last", () => {
    const sizes = Array.from({ length: blocks - 1 }, (_, block) => {
      return partition.starts[block + 1] - partition.starts[block];
    });
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    const key = (row: number) => (Number.isNaN(pixels[row]) ? Infinity : pixels[row]);
    for (let block = 0; block + 2 < blocks; ++block) {
      const rowsOf = (b: number) =>
        Array.from(partition.order.subarray(partition.starts[b], partition.starts[b + 1]));
      const highest = Math.max(...rowsOf(block).map(key));
      const lowest = Math.min(...rowsOf(block + 1).map(key));
      expect(highest).toBeLessThanOrEqual(lowest);
    }
    const lastFocusBlock = Array.from(
      partition.order.subarray(partition.starts[blocks - 2], partition.starts[blocks - 1]),
    );
    expect(lastFocusBlock.some((row) => Number.isNaN(pixels[row]))).toBe(true);
  });

  test("keeps the draw order within each block", () => {
    const position = new Uint32Array(rows);
    drawOrder.forEach((row, at) => {
      position[row] = at;
    });
    for (let block = 0; block < blocks; ++block) {
      for (let at = partition.starts[block] + 1; at < partition.starts[block + 1]; ++at) {
        expect(position[partition.order[at - 1]]).toBeLessThan(position[partition.order[at]]);
      }
    }
  });

  test("takes no more blocks than focus rows, and one empty block without focus rows", () => {
    expect(
      partitionRows(
        new Float32Array([1, 2, 3]),
        new Uint8Array([1, 0, 1]),
        new Uint32Array([2, 1, 0]),
        8,
      ).starts,
    ).toEqual(new Uint32Array([0, 1, 2, 3]));
    expect(
      partitionRows(new Float32Array([1, 2]), new Uint8Array(2), new Uint32Array([0, 1]), 4).starts,
    ).toEqual(new Uint32Array([0, 0, 2]));
  });

  test("rejects mismatched rows and block counts below one", () => {
    expect(() =>
      partitionRows(new Float32Array(3), new Uint8Array(2), new Uint32Array(3), 2),
    ).toThrow();
    expect(() =>
      partitionRows(new Float32Array(3), new Uint8Array(3), new Uint32Array(2), 2),
    ).toThrow();
    expect(() =>
      partitionRows(new Float32Array(3), new Uint8Array(3), new Uint32Array(3), 0),
    ).toThrow();
  });
});

describe("BlockSelection", () => {
  const random = seeded(11);
  const rows = 1003;
  const pixels = Float32Array.from({ length: rows }, () => random() * 100);
  const focus = Uint8Array.from({ length: rows }, () => Number(random() < 0.8));
  const partition = partitionRows(pixels, focus, shuffled(rows, random), 12);
  const blocks = partition.starts.length - 1;

  /** States recounted from every row, the reference for incremental updates. */
  function recount(selection: Uint8Array): { states: number[]; partialRows: number } {
    let partialRows = 0;
    const states = Array.from({ length: blocks }, (_, block) => {
      const start = partition.starts[block];
      const end = partition.starts[block + 1];
      let selected = 0;
      for (let at = start; at < end; ++at) selected += selection[partition.order[at]];
      if (selected === 0) return LAYER_CONTEXT;
      if (selected === end - start) return LAYER_SELECTED;
      partialRows += end - start;
      return LAYER_SKIPPED;
    });
    return { states, partialRows };
  }

  test("tracks each block's state from changed rows as a full recount would", () => {
    const tracked = new BlockSelection(partition);
    const states = new Uint8Array(blocks);
    // A moving brush on the focus axis, then arbitrary selections, then none at all.
    const selections = [
      ...[10, 20, 35, 30].map((top) =>
        Uint8Array.from(pixels, (y, row) => Number(focus[row] === 1 && y >= top && y < top + 40)),
      ),
      Uint8Array.from({ length: rows }, () => Number(random() < 0.5)),
      new Uint8Array(rows).fill(1),
      new Uint8Array(rows),
    ];
    for (const selection of selections) {
      const partialRows = tracked.update(selection, states);
      const expected = recount(selection);
      expect(Array.from(states)).toEqual(expected.states);
      expect(partialRows).toBe(expected.partialRows);
    }
  });

  test("reads selections at any byte offset", () => {
    const tracked = new BlockSelection(partition);
    const states = new Uint8Array(blocks);
    const buffer = new Uint8Array(rows + 1);
    const selection = buffer.subarray(1);
    for (let row = 0; row < rows; ++row) selection[row] = Number(pixels[row] > 50);
    tracked.update(selection, states);
    expect(Array.from(states)).toEqual(recount(selection).states);
  });

  test("rejects flags other than 0 and 1 and mismatched lengths", () => {
    const tracked = new BlockSelection(partition);
    const states = new Uint8Array(blocks);
    const flags = new Uint8Array(rows);
    flags[5] = 2;
    expect(() => tracked.update(flags, states)).toThrow();
    expect(() => tracked.update(new Uint8Array(rows - 1), states)).toThrow();
    expect(() => tracked.update(new Uint8Array(rows), new Uint8Array(blocks - 1))).toThrow();
  });
});

describe("PartialSlots", () => {
  const rows = 40;
  const pixels = Float32Array.from({ length: rows }, (_, row) => row);
  const partition = partitionRows(
    pixels,
    new Uint8Array(rows).fill(1),
    Uint32Array.from({ length: rows }, (_, row) => row),
    8,
  );
  const blocks = partition.starts.length - 1;
  const statesFor = (partial: number[]) =>
    Uint8Array.from({ length: blocks }, (_, block) =>
      partial.includes(block) ? LAYER_SKIPPED : LAYER_CONTEXT,
    );
  const halves = (plan: SlotPlan) =>
    plan.draw.map(({ slot, half, block, positions, clear }) => ({
      slot,
      half,
      block,
      positions,
      clear,
    }));

  test("draws a new partial block's two halves, then nothing while its selection holds", () => {
    const slots = new PartialSlots(5);
    const selection = Uint8Array.from(pixels, (y) => Number(y < 7));
    const first = slots.plan(partition, selection, statesFor([1]));
    expect(halves(first)).toEqual([
      { slot: 0, half: SELECTED_HALF, block: 1, positions: [0, 1], clear: true },
      { slot: 0, half: DESELECTED_HALF, block: 1, positions: [2, 3, 4], clear: true },
    ]);
    expect(first.used).toBe(1);
    const unchanged = slots.plan(partition, selection, statesFor([1]));
    expect(unchanged.draw).toEqual([]);
    expect(unchanged.used).toBe(1);
  });

  test("adds rows that join a half and draws again the half they left", () => {
    const slots = new PartialSlots(5);
    const selection = Uint8Array.from(pixels, (y) => Number(y < 7));
    slots.plan(partition, selection, statesFor([1]));
    selection[7] = 1;
    expect(halves(slots.plan(partition, selection, statesFor([1])))).toEqual([
      { slot: 0, half: SELECTED_HALF, block: 1, positions: [2], clear: false },
      { slot: 0, half: DESELECTED_HALF, block: 1, positions: [3, 4], clear: true },
    ]);
    selection[6] = 0;
    selection[7] = 0;
    expect(halves(slots.plan(partition, selection, statesFor([1])))).toEqual([
      { slot: 0, half: SELECTED_HALF, block: 1, positions: [0], clear: true },
      { slot: 0, half: DESELECTED_HALF, block: 1, positions: [1, 2], clear: false },
    ]);
    // Rows that both join and leave the selection draw both halves again.
    selection[5] = 0;
    selection[6] = 1;
    expect(halves(slots.plan(partition, selection, statesFor([1])))).toEqual([
      { slot: 0, half: SELECTED_HALF, block: 1, positions: [1], clear: true },
      { slot: 0, half: DESELECTED_HALF, block: 1, positions: [0, 2, 3, 4], clear: true },
    ]);
  });

  test("keeps a block's slot while it is whole, and reuses it when it is partial again", () => {
    const slots = new PartialSlots(5);
    const selection = Uint8Array.from(pixels, (y) => Number(y < 7 || (y >= 20 && y < 22)));
    slots.plan(partition, selection, statesFor([1, 4]));
    expect(slots.plan(partition, selection, statesFor([4])).used).toBe(2);
    const again = slots.plan(partition, selection, statesFor([1, 4]));
    expect(again.draw).toEqual([]);
    expect(again.used).toBe(3);
  });

  test("clears both halves of a slot handed to another block", () => {
    const slots = new PartialSlots(5);
    const partial = Array.from({ length: PARTIAL_SLOTS }, (_, block) => block);
    const selection = Uint8Array.from(pixels, (y) => Number(y % 5 === 0));
    slots.plan(partition, selection, statesFor(partial));
    // Block 0 is whole now; its slot goes to block PARTIAL_SLOTS.
    selection.fill(1, 0, 5);
    selection[PARTIAL_SLOTS * 5] = 1;
    const handed = halves(
      slots.plan(partition, selection, statesFor([...partial.slice(1), PARTIAL_SLOTS])),
    );
    expect(handed).toEqual([
      { slot: 0, half: SELECTED_HALF, block: PARTIAL_SLOTS, positions: [0], clear: true },
      {
        slot: 0,
        half: DESELECTED_HALF,
        block: PARTIAL_SLOTS,
        positions: [1, 2, 3, 4],
        clear: true,
      },
    ]);
  });

  test("updates a block partial again from what its slot drew before it was whole", () => {
    const slots = new PartialSlots(5);
    const selection = Uint8Array.from(pixels, (y) => Number(y < 7));
    slots.plan(partition, selection, statesFor([1]));
    selection.fill(0, 5, 10);
    expect(slots.plan(partition, selection, statesFor([])).draw).toEqual([]);
    selection.fill(1, 5, 9);
    // Rows 5 and 6 were drawn selected; rows 7 and 8 join them.
    expect(halves(slots.plan(partition, selection, statesFor([1])))).toEqual([
      { slot: 0, half: SELECTED_HALF, block: 1, positions: [2, 3], clear: false },
      { slot: 0, half: DESELECTED_HALF, block: 1, positions: [4], clear: true },
    ]);
  });

  test("draws blocks beyond the slots, or larger than slots take, directly", () => {
    const slots = new PartialSlots(5);
    const selection = Uint8Array.from(pixels, (y) => Number(y % 5 === 0));
    const partial = Array.from({ length: PARTIAL_SLOTS + 2 }, (_, block) => block);
    const plan = slots.plan(partition, selection, statesFor(partial));
    expect(new Set(plan.draw.map(({ block }) => block))).toEqual(
      new Set(partial.slice(0, PARTIAL_SLOTS)),
    );
    expect(plan.overflow).toEqual(partial.slice(PARTIAL_SLOTS));
    expect(plan.used).toBe((1 << PARTIAL_SLOTS) - 1);
    const narrow = new PartialSlots(4);
    expect(narrow.plan(partition, selection, statesFor([0])).overflow).toEqual([0]);
  });
});

describe("blockCountFor", () => {
  test("fits the layer memory, the device's layers and useful block sizes", () => {
    const pixels = 1000 * 500;
    const layerBytes = 16;
    const affordable =
      Math.floor(BLOCK_MEMORY_BYTES / (pixels * layerBytes)) - 1 - 2 * PARTIAL_SLOTS;
    expect(blockCountFor(1_000_000, pixels, layerBytes, 2048)).toBe(affordable);
    expect(blockCountFor(1_000_000, pixels, layerBytes, 64)).toBe(64 - 1 - 2 * PARTIAL_SLOTS);
    expect(blockCountFor(10 * MIN_BLOCK_ROWS, pixels, layerBytes, 2048)).toBe(10);
  });

  test("leaves brushing to drafts when too few blocks fit, counting every layer", () => {
    const layerBytes = 32;
    const largest = Math.floor(
      BLOCK_MEMORY_BYTES / ((MIN_FOCUS_BLOCKS + 1 + 2 * PARTIAL_SLOTS) * layerBytes),
    );
    expect(blocksFit(largest, layerBytes)).toBe(true);
    expect(blocksFit(largest + 1, layerBytes)).toBe(false);
    // A 1920 x 800 plot at device pixel ratio 2, coloring by the highest value.
    expect(blocksFit(3840 * 1600, layerBytes)).toBe(false);
    expect(() => blockCountFor(1_000_000, largest + 1, layerBytes, 2048)).toThrow();
    expect(blockCountFor(1_000_000, largest, layerBytes, 2048)).toBe(MIN_FOCUS_BLOCKS);
  });
});
