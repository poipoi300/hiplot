import { describe, expect, test } from "bun:test";
import { create_d3_scale, infertypes, scale_pixels_range } from "../infertypes";
import { d3_scale_categorical, type Scale } from "../lib/d3_scales";
import { PersistentStateInMemory } from "../lib/savedstate";
import { type DatapointValue, ParamType } from "../types";
import {
  type AxisBrush,
  type AxisInterval,
  intervalPixels,
  isSavedBrushes,
  mergeBrushes,
  pixelInterval,
  savedBrushFor,
  savedBrushIntervals,
  savedBrushOf,
} from "./brushes";
import { categoryTagTexts, type PlacedTag, placeBrushTags, type TagMetrics } from "./brushtags";

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
  test("valid saved brushes are accepted, in values or as earlier positions", () => {
    expect(isSavedBrushes({})).toBe(true);
    expect(
      isSavedBrushes({
        lr: [{ min: 1e-4, max: 0.01, include_infnans: false }, [0.5, 1]],
        opt: [{ categories: ["adam", "sgd"] }],
      }),
    ).toBe(true);
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
      { lr: [{ min: 2, max: 1, include_infnans: false }] },
      { lr: [{ min: 0, max: Number.POSITIVE_INFINITY, include_infnans: false }] },
      { lr: [{ min: 0, max: 1 }] },
      { opt: [{ categories: [1] }] },
    ]) {
      expect(isSavedBrushes(value)).toBe(false);
    }
  });
});

describe("brushes saved in values", () => {
  const numeric = (values: DatapointValue[]) => {
    const scale = create_d3_scale(
      infertypes(
        new PersistentStateInMemory("", {}),
        values.map((value, index) => ({ uid: `${index}`, from_uid: null, x: value })),
      ).x,
    ).range([400, 0]);
    if (scale.kind !== "continuous") {
      throw new Error("Expected a numeric axis");
    }
    return scale;
  };
  const tenths = Array.from({ length: 11 }, (_, i) => i / 10);
  const pixelsOf = (scale: Scale, interval: AxisInterval) =>
    intervalPixels(scale.range(), interval);

  test("a numeric brush saves its values and selects them again on reload", () => {
    const scale = numeric(tenths);
    const saved = savedBrushOf(scale_pixels_range(scale, [80, 240]));
    expect(saved).toEqual({ min: 0.4, max: 0.8, include_infnans: false });
    const [interval] = savedBrushIntervals(scale, saved);
    expect(pixelsOf(scale, interval).top).toBeCloseTo(80);
    expect(pixelsOf(scale, interval).bottom).toBeCloseTo(240);
  });

  test("a numeric brush keeps its values when the data's range changed", () => {
    const saved = { min: 0.4, max: 0.8, include_infnans: false };
    const wider = numeric([...tenths, 2]);
    const [interval] = savedBrushIntervals(wider, saved);
    const span = pixelsOf(wider, interval);
    expect(wider.invert(span.bottom)).toBeCloseTo(0.4);
    expect(wider.invert(span.top)).toBeCloseTo(0.8);
    expect(savedBrushIntervals(numeric([5, 6, 7, 8, 9, 10, 11, 12]), saved)).toEqual([]);
  });

  test("a brush reaching the outlier band covers it again; one on the band alone, its outer half", () => {
    const scale = numeric([...tenths, "nan"]);
    const [through] = savedBrushIntervals(scale, { min: 0.5, max: 1, include_infnans: true });
    expect(pixelsOf(scale, through).top).toBe(0);
    const [band] = savedBrushIntervals(scale, { min: 1.1, max: 1.1, include_infnans: true });
    expect(pixelsOf(scale, band)).toEqual({ top: 0, bottom: 15 });
    const selection = scale_pixels_range(scale, [0, 15]);
    expect(selection.type !== ParamType.CATEGORICAL && selection.include_infnans).toBe(true);
  });

  test("a categorical brush saves its categories and covers each run of them on reload", () => {
    const scale = Object.assign(d3_scale_categorical(["a", "b", "c", "d", "e"]).range([400, 0]), {
      paramType: ParamType.CATEGORICAL,
    });
    expect(savedBrushOf(scale_pixels_range(scale, [90, 210]))).toEqual({ categories: ["c", "d"] });
    const intervals = savedBrushIntervals(scale, { categories: ["e", "b", "a", "gone"] });
    expect(intervals.map((interval) => pixelsOf(scale, interval))).toEqual([
      { top: 292, bottom: 400 },
      { top: 0, bottom: 8 },
    ]);
    for (const interval of intervals) {
      const span = pixelsOf(scale, interval);
      const selected = scale_pixels_range(scale, [span.top, span.bottom]);
      expect(selected.type === ParamType.CATEGORICAL && selected.values.length).toBeGreaterThan(0);
    }
    expect(savedBrushIntervals(scale, { min: 0, max: 1, include_infnans: false })).toEqual([]);
    expect(savedBrushIntervals(numeric(tenths), { categories: ["a"] })).toEqual([]);
  });

  test("a brush that selects a value saves the values", () => {
    const scale = numeric(tenths);
    const interval = pixelInterval(scale.range(), { top: 80, bottom: 240 });
    expect(savedBrushFor(scale, interval)).toEqual({ min: 0.4, max: 0.8, include_infnans: false });
  });

  test("a brush that selects no value saves its positions, so it reloads in place and still selects nothing", () => {
    const categorical = Object.assign(d3_scale_categorical(["a", "b", "c"]).range([400, 0]), {
      paramType: ParamType.CATEGORICAL,
    });
    const betweenCategories = pixelInterval(categorical.range(), { top: 120, bottom: 150 });
    const nanAxis = numeric([...tenths, "nan"]);
    const highest = nanAxis(1);
    const betweenMaximumAndBand = pixelInterval(nanAxis.range(), {
      top: highest - 4,
      bottom: highest - 1,
    });
    for (const [scale, interval] of [
      [categorical, betweenCategories],
      [nanAxis, betweenMaximumAndBand],
    ] as const) {
      const saved = savedBrushFor(scale, interval);
      expect(saved).toEqual([interval.start, interval.end]);
      expect(isSavedBrushes({ x: [saved] })).toBe(true);
      const selected = scale_pixels_range(scale, [
        intervalPixels(scale.range(), interval).top,
        intervalPixels(scale.range(), interval).bottom,
      ]);
      expect(savedBrushIntervals(scale, savedBrushOf(selected))).toEqual([]);
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
    const tags = placeBrushTags([{ top: 100, bottom: 200, single: false }], metrics);
    expect(tags).toEqual([
      { brush: 0, edge: "top", center: 88, inside: false },
      { brush: 0, edge: "bottom", center: 212, inside: false },
    ]);
  });

  test("a brush covering a single category takes one tag, at its top edge", () => {
    const tags = placeBrushTags([{ top: 100, bottom: 200, single: true }], metrics);
    expect(tags).toEqual([{ brush: 0, edge: "top", center: 88, inside: false }]);
  });

  test("an edge at an axis end takes its tag inside", () => {
    const tags = placeBrushTags([{ top: 5, bottom: 410, single: false }], metrics);
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
        { top: 50, bottom: 150, single: false },
        { top: 170, bottom: 300, single: false },
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
        { top: 50, bottom: 150, single: false },
        { top: 200, bottom: 300, single: false },
      ],
      metrics,
    );
    expect(distant.every((tag) => !tag.inside)).toBe(true);
  });

  test("the placement does not depend on the order of the brushes", () => {
    const spans = [
      { top: 200, bottom: 230, single: false },
      { top: 20, bottom: 60, single: false },
      { top: 240, bottom: 380, single: false },
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
        { top: 100, bottom: 104, single: false },
        { top: 106, bottom: 112, single: false },
        { top: 113, bottom: 114, single: false },
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
      single: false,
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
        return { top: Math.min(a, b), bottom: Math.max(a, b), single: next() < 0.3 };
      });
      const tags = placeBrushTags(spans, metrics);
      expectNoOverlap(tags, metrics);
      expect(placeBrushTags(spans, metrics)).toEqual(tags);
    }
  });
});

describe("categorical brush tags", () => {
  const categories = ["adam", "adamw", "sgd"];
  const upright = d3_scale_categorical(categories).range([400, 0]);

  test("the top tag names the category drawn highest, whatever the domain order", () => {
    // On an upright axis the first category of the domain is drawn at the bottom.
    expect(categoryTagTexts(["adam", "adamw"], upright)).toEqual({ top: "adamw", bottom: "adam" });
    const inverted = d3_scale_categorical(categories).range([0, 400]);
    expect(categoryTagTexts(["adam", "adamw"], inverted)).toEqual({ top: "adam", bottom: "adamw" });
  });

  test("a brush covering one category, or none, takes a single tag", () => {
    expect(categoryTagTexts(["sgd"], upright)).toEqual({ top: "sgd", bottom: null });
    expect(categoryTagTexts([], upright)).toEqual({ top: "none", bottom: null });
  });
});
