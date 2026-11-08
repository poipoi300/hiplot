import { describe, expect, test } from "bun:test";
import {
  type AxisBrush,
  intervalPixels,
  isSavedBrushes,
  mergeBrushes,
  pixelInterval,
} from "./brushes";
import { type PlacedTag, placeBrushTags, type TagMetrics } from "./brushtags";

const brush = (id: number, start: number, end: number): AxisBrush => ({ id, start, end });

describe("brush intervals", () => {
  test("positions follow the scale range, so an inverted axis keeps the values", () => {
    const interval = { start: 0.25, end: 0.5 };
    expect(intervalPixels([400, 0], interval)).toEqual({ top: 200, bottom: 300 });
    expect(intervalPixels([0, 400], interval)).toEqual({ top: 100, bottom: 200 });
  });

  test("pixels and positions convert both ways", () => {
    for (const range of [
      [400, 0],
      [0, 400],
    ] as const) {
      expect(pixelInterval(range, intervalPixels(range, { start: 0.1, end: 0.7 }))).toEqual({
        start: 0.1,
        end: 0.7,
      });
    }
  });
});

describe("merging brushes", () => {
  test("overlapping and touching brushes merge, keeping the oldest id", () => {
    expect(mergeBrushes([brush(3, 0.4, 0.6), brush(1, 0.5, 0.9), brush(2, 0.9, 1)], 0)).toEqual([
      brush(1, 0.4, 1),
    ]);
  });

  test("brushes further apart than the touching distance stay separate, sorted", () => {
    expect(mergeBrushes([brush(1, 0.5, 0.6), brush(2, 0.1, 0.2)], 0.01)).toEqual([
      brush(2, 0.1, 0.2),
      brush(1, 0.5, 0.6),
    ]);
    expect(mergeBrushes([brush(1, 0.5, 0.6), brush(2, 0.1, 0.495)], 0.01)).toEqual([
      brush(1, 0.1, 0.6),
    ]);
  });

  test("a brush inside another merges into it", () => {
    expect(mergeBrushes([brush(2, 0.2, 0.3), brush(1, 0.1, 0.8)], 0)).toEqual([brush(1, 0.1, 0.8)]);
  });

  test("merging leaves its input untouched", () => {
    const input = [brush(1, 0.1, 0.5), brush(2, 0.4, 0.6)];
    mergeBrushes(input, 0);
    expect(input).toEqual([brush(1, 0.1, 0.5), brush(2, 0.4, 0.6)]);
  });
});

describe("saved brushes", () => {
  test("valid saved brushes are accepted", () => {
    expect(isSavedBrushes({})).toBe(true);
    expect(
      isSavedBrushes({
        lr: [
          [0, 0.2],
          [0.5, 1],
        ],
        opt: [],
      }),
    ).toBe(true);
  });

  test("malformed saved brushes are rejected", () => {
    for (const value of [
      null,
      [],
      "lr",
      { lr: [0, 1] },
      { lr: [[0.5, 0.2]] },
      { lr: [[-0.1, 0.2]] },
      { lr: [[0.1, 1.2]] },
      { lr: [[0.1, Number.NaN]] },
      { lr: [[0.1, 0.2, 0.3]] },
      { lr: [["0", 1]] },
    ]) {
      expect(isSavedBrushes(value)).toBe(false);
    }
  });
});

const metrics: TagMetrics = { height: 18, gap: 3, min: 0, max: 415 };

function tagOf(tags: PlacedTag[], brush: number, edge: "top" | "bottom"): PlacedTag {
  const tag = tags.find((placed) => placed.brush === brush && placed.edge === edge);
  if (tag === undefined) {
    throw new Error(`No ${edge} tag for brush ${brush}`);
  }
  return tag;
}

function expectNoOverlap(tags: PlacedTag[], { height, min, max }: TagMetrics): void {
  const sorted = tags.map((tag) => tag.center).sort((a, b) => a - b);
  sorted.forEach((center, index) => {
    expect(center - height / 2).toBeGreaterThanOrEqual(min - 1e-9);
    expect(center + height / 2).toBeLessThanOrEqual(max + 1e-9);
    if (index > 0) {
      expect(center - sorted[index - 1]).toBeGreaterThanOrEqual(height - 1e-9);
    }
  });
}

/** A seeded generator, so the random layouts below are the same on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

describe("brush tag placement", () => {
  test("a brush with room around it is tagged outside both edges", () => {
    const tags = placeBrushTags([{ top: 100, bottom: 200 }], metrics);
    expect(tags).toEqual([
      { brush: 0, edge: "top", center: 88, inside: false },
      { brush: 0, edge: "bottom", center: 212, inside: false },
    ]);
  });

  test("an edge at an axis end takes its tag inside", () => {
    const tags = placeBrushTags([{ top: 5, bottom: 410 }], metrics);
    expect(tagOf(tags, 0, "top")).toEqual({ brush: 0, edge: "top", center: 17, inside: true });
    expect(tagOf(tags, 0, "bottom")).toEqual({
      brush: 0,
      edge: "bottom",
      center: 398,
      inside: true,
    });
  });

  test("close neighbors take their facing tags inside; distant ones keep them outside", () => {
    const close = placeBrushTags(
      [
        { top: 50, bottom: 150 },
        { top: 170, bottom: 300 },
      ],
      metrics,
    );
    expect(tagOf(close, 0, "bottom").inside).toBe(true);
    expect(tagOf(close, 1, "top").inside).toBe(true);
    expect(tagOf(close, 0, "top").inside).toBe(false);
    expect(tagOf(close, 1, "bottom").inside).toBe(false);
    expect(tagOf(close, 0, "bottom").center).toBe(138);
    expect(tagOf(close, 1, "top").center).toBe(182);

    const distant = placeBrushTags(
      [
        { top: 50, bottom: 150 },
        { top: 200, bottom: 300 },
      ],
      metrics,
    );
    expect(distant.every((tag) => !tag.inside)).toBe(true);
  });

  test("the placement does not depend on the order of the brushes", () => {
    const spans = [
      { top: 200, bottom: 230 },
      { top: 20, bottom: 60 },
      { top: 240, bottom: 380 },
    ];
    const forward = placeBrushTags(spans, metrics);
    const backward = placeBrushTags(spans.slice().reverse(), metrics);
    for (const tag of forward) {
      const twin = tagOf(backward, spans.length - 1 - tag.brush, tag.edge);
      expect(twin.center).toBe(tag.center);
      expect(twin.inside).toBe(tag.inside);
    }
  });

  test("tags of brushes too short to hold them are pushed apart, never overlapping", () => {
    const tags = placeBrushTags(
      [
        { top: 100, bottom: 104 },
        { top: 106, bottom: 112 },
        { top: 113, bottom: 114 },
      ],
      metrics,
    );
    expect(tags).toHaveLength(6);
    expectNoOverlap(tags, metrics);
    // Each brush's top tag stays above its bottom tag, and brushes keep their order.
    expect(tags.map((tag) => `${tag.brush}${tag.edge}`)).toEqual([
      "0top",
      "0bottom",
      "1top",
      "1bottom",
      "2top",
      "2bottom",
    ]);
    expect(tags.map((tag) => tag.center)).toEqual(
      tags.map((tag) => tag.center).sort((a, b) => a - b),
    );
  });

  test("an axis too short for every tag leaves out those of the lowest brushes", () => {
    const short: TagMetrics = { ...metrics, max: 80 };
    const spans = [0, 1, 2, 3, 4].map((index) => ({
      top: index * 15 + 1,
      bottom: index * 15 + 10,
    }));
    const tags = placeBrushTags(spans, short);
    expect(new Set(tags.map((tag) => tag.brush))).toEqual(new Set([0]));
    expectNoOverlap(tags, short);
  });

  test("random layouts never overlap and are reproducible", () => {
    const next = random(7);
    for (let round = 0; round < 300; ++round) {
      const count = 1 + Math.floor(next() * 8);
      const spans = Array.from({ length: count }, () => {
        const a = next() * metrics.max;
        const b = Math.min(metrics.max - 15, a + next() * 60);
        return { top: Math.min(a, b), bottom: Math.max(a, b) };
      });
      const tags = placeBrushTags(spans, metrics);
      expectNoOverlap(tags, metrics);
      expect(placeBrushTags(spans, metrics)).toEqual(tags);
    }
  });
});
