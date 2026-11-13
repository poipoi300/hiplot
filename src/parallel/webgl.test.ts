import { describe, expect, test } from "bun:test";
import { segmentsCovering } from "./webgl";

describe("segmentsCovering", () => {
  // Axes at 100, 200 and 300 CSS pixels; segment 0 is the stub before the first axis.
  const axes = [{ x: 100 }, { x: 200 }, { x: 300 }];

  test("takes the segments whose lines, stubs and corners can reach the columns", () => {
    // Columns 0-10 at scale 1: only the stub leading into the first axis comes within 15 pixels.
    expect(segmentsCovering(axes, 1, 0, 0, 10)).toBeNull();
    expect(segmentsCovering(axes, 1, 0, 0, 86)).toEqual({ first: 0, count: 1 });
    // Columns between two axes take the segment joining them.
    expect(segmentsCovering(axes, 1, 0, 110, 120)).toEqual({ first: 1, count: 1 });
    // A stub leaving the last axis reaches 15 pixels past it, into the segment after it.
    expect(segmentsCovering(axes, 1, 0, 310, 320)).toEqual({ first: 3, count: 1 });
    expect(segmentsCovering(axes, 1, 0, 290, 320)).toEqual({ first: 2, count: 2 });
    expect(segmentsCovering(axes, 1, 0, 316, 400)).toBeNull();
  });

  test("widens by the corner margin and scales to target pixels", () => {
    expect(segmentsCovering(axes, 1, 5, 316, 400)).toEqual({ first: 3, count: 1 });
    expect(segmentsCovering(axes, 2, 0, 0, 172)).toEqual({ first: 0, count: 1 });
    expect(segmentsCovering(axes, 2, 0, 0, 170)).toBeNull();
  });

  test("keeps the segments between the run's ends, in a full frame's order", () => {
    expect(segmentsCovering(axes, 1, 0, 0, 1000)).toEqual({ first: 0, count: 4 });
    // Crossed axes during a drag still give one run.
    expect(segmentsCovering([{ x: 300 }, { x: 100 }], 1, 0, 150, 160)).toEqual({
      first: 1,
      count: 1,
    });
  });
});
