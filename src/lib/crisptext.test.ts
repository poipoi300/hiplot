import { describe, expect, test } from "bun:test";
import { devicePixelShift, lengthInPixels, runStart } from "./crisptext";

describe("snapping text to device pixels", () => {
  test("a position moves to the nearest device pixel, by less than half of one", () => {
    expect(devicePixelShift(551.941, 1)).toBeCloseTo(0.059);
    expect(devicePixelShift(463.466, 1)).toBeCloseTo(-0.466);
    expect(devicePixelShift(463.466, 2)).toBeCloseTo(0.034);
    expect(devicePixelShift(12.25, 2)).toBeCloseTo(0.25);
    expect(devicePixelShift(40, 1.5)).toBeCloseTo(0);
  });

  test("a position already on a device pixel stays", () => {
    expect(devicePixelShift(120, 1)).toBe(0);
    expect(devicePixelShift(120.5, 2)).toBe(0);
  });

  test("lengths read in pixels, em lengths in units of the font size", () => {
    expect(lengthInPixels("0.32em", 11)).toBeCloseTo(3.52);
    expect(lengthInPixels("-9", 11)).toBe(-9);
    expect(lengthInPixels(null, 11)).toBe(0);
    expect(lengthInPixels("", 11)).toBe(0);
    expect(() => lengthInPixels("auto", 11)).toThrow("Not a single SVG length");
  });

  test("a run starts at its anchor, half its length before, or its length before", () => {
    expect(runStart(10, 30, "start")).toBe(10);
    expect(runStart(10, 30, "middle")).toBe(-5);
    expect(runStart(10, 30, "end")).toBe(-20);
  });
});
