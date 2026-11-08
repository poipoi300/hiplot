import { expect, test } from "bun:test";
import { panelPlacement } from "./popover";

const viewport = { width: 1000, height: 800 };

test("a panel opens below its button, as tall as the room there", () => {
  const button = { top: 100, bottom: 128, left: 40, right: 140 };
  expect(panelPlacement(button, viewport, "start")).toEqual({
    top: 134,
    maxHeight: 800 - 128 - 6 - 8,
    left: 40,
  });
  expect(panelPlacement(button, viewport, "end")).toEqual({
    top: 134,
    maxHeight: 800 - 128 - 6 - 8,
    right: 860,
  });
});

test("near the bottom of the viewport a panel opens above its button", () => {
  const button = { top: 700, bottom: 728, left: 40, right: 140 };
  expect(panelPlacement(button, viewport, "start")).toEqual({
    bottom: 800 - 700 + 6,
    maxHeight: 700 - 6 - 8,
    left: 40,
  });
});

test("a panel stays below while that side has the room it needs or the most room", () => {
  const roomy = { top: 400, bottom: 428, left: 0, right: 10 };
  expect(panelPlacement(roomy, viewport, "start").top).toBe(434);
  const short = { top: 60, bottom: 88, left: 0, right: 10 };
  expect(panelPlacement(short, { width: 1000, height: 300 }, "start").top).toBe(94);
});
