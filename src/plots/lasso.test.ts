import { describe, expect, test } from "bun:test";
import { insidePolygon, lassoed, WHEEL_GESTURE_GAP_MS, WheelLatch } from "./lasso";

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("lasso selection", () => {
  test("points inside the drawn shape are in, outside ones out", () => {
    expect(insidePolygon(5, 5, square)).toBe(true);
    expect(insidePolygon(15, 5, square)).toBe(false);
    const notch = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(insidePolygon(8, 5, notch)).toBe(false);
    expect(insidePolygon(2, 5, notch)).toBe(true);
  });

  test("only candidate points on screen inside the lasso are picked", () => {
    const positions = [{ x: 5, y: 5 }, { x: 50, y: 5 }, { x: 2, y: 2 }, null];
    const candidates = Uint8Array.from([1, 1, 0, 1]);
    expect(lassoed(candidates, (index) => positions[index], square)).toEqual([0]);
  });

  test("a gesture too short to enclose anything picks nothing", () => {
    expect(lassoed(Uint8Array.from([1]), () => ({ x: 0, y: 0 }), square.slice(0, 2))).toEqual([]);
  });
});

describe("wheel gestures", () => {
  test("a plot takes over only the wheel gestures that started on it", () => {
    const plot = document.createElement("div");
    const canvas = document.createElement("canvas");
    plot.appendChild(canvas);
    const page = document.createElement("main");
    const latch = new WheelLatch();

    // A page scroll that then passes over the plot stays a page scroll.
    latch.record(page, 0);
    latch.record(canvas, 50);
    expect(latch.startedInside(plot)).toBe(false);

    // After a pause, a gesture that starts on the plot is the plot's.
    latch.record(canvas, 50 + WHEEL_GESTURE_GAP_MS + 1);
    latch.record(page, 60 + WHEEL_GESTURE_GAP_MS + 1);
    expect(latch.startedInside(plot)).toBe(true);
  });
});
