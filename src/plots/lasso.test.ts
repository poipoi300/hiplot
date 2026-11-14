import { describe, expect, test } from "bun:test";
import {
  insidePolygon,
  lassoSpan,
  startsLasso,
  WHEEL_GESTURE_GAP_MS,
  WheelLatch,
  withinLasso,
} from "./lasso";

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

  test("every point on screen inside the lasso is in, and only those", () => {
    const inside = withinLasso(square);
    const positions = [
      { x: 5, y: 5 },
      { x: 50, y: 5 },
      { x: 2, y: 2 },
      { x: Number.NaN, y: 5 },
    ];
    expect(positions.map(inside)).toEqual([true, false, true, false]);
  });

  test("a primary press with Ctrl or Cmd starts a lasso; others do what they always did", () => {
    expect(startsLasso({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
    expect(startsLasso({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
    expect(startsLasso({ button: 0, ctrlKey: false, metaKey: false })).toBe(false);
    expect(startsLasso({ button: 2, ctrlKey: true, metaKey: false })).toBe(false);
  });

  test("a gesture too short to enclose anything takes nothing", () => {
    expect(withinLasso(square.slice(0, 2))({ x: 0, y: 0 })).toBe(false);
  });

  test("on one axis, the lasso spans its extent along that axis", () => {
    expect(lassoSpan(square, "x")).toEqual([0, 10]);
    const tall = square.map(({ x, y }) => ({ x, y: y * 2 }));
    expect(lassoSpan(tall, "y")).toEqual([0, 20]);
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
