import { describe, expect, test } from "bun:test";
import { infertypes } from "../infertypes";
import { PersistentStateInMemory } from "../lib/savedstate";
import type { Datapoint } from "../types";
import { colorOrientation, NO_ORIENTATION } from "./orientation";

/** Rows whose loss falls as accuracy rises, with an optimizer that tracks accuracy. */
function trials(): Datapoint[] {
  const optimizers = ["sgd", "adam", "rmsprop"];
  return Array.from({ length: 300 }, (_, i) => ({
    uid: `${i}`,
    from_uid: null,
    accuracy: i / 300,
    loss: 1 - i / 300 + (i % 7) * 0.01,
    lr: 10 ** (-4 + (3 * i) / 300),
    // sgd for the worst third, adam for the middle one, rmsprop for the best
    optimizer: optimizers[Math.floor(i / 100)],
  }));
}

function orientationFor(rows: Datapoint[], colorby: string) {
  return colorOrientation(rows, infertypes(new PersistentStateInMemory("", {}), rows), colorby);
}

describe("axes facing the color gradient", () => {
  test("an axis that falls as the color rises is inverted, one that rises is not", () => {
    const { inverted } = orientationFor(trials(), "accuracy");
    expect(inverted.has("loss")).toBe(true);
    expect(inverted.has("lr")).toBe(false);
    expect(inverted.has("accuracy")).toBe(false);
  });

  test("the color column itself keeps high values at the top", () => {
    const { inverted } = orientationFor(trials(), "loss");
    expect(inverted.has("loss")).toBe(false);
    expect(inverted.has("accuracy")).toBe(true);
  });

  test("categories sit in the order of their mean color, lowest at the bottom", () => {
    expect(orientationFor(trials(), "accuracy").categoryOrder.get("optimizer")).toEqual([
      "sgd",
      "adam",
      "rmsprop",
    ]);
    expect(orientationFor(trials(), "loss").categoryOrder.get("optimizer")).toEqual([
      "rmsprop",
      "adam",
      "sgd",
    ]);
  });

  test("categories without colored rows go first and keep their natural order", () => {
    const rows = trials().map((row, i) => ({
      ...row,
      accuracy: i < 20 ? null : row.accuracy,
      optimizer: i < 10 ? "zeta" : i < 20 ? "alpha" : row.optimizer,
    }));
    expect(orientationFor(rows, "accuracy").categoryOrder.get("optimizer")).toEqual([
      "alpha",
      "zeta",
      "sgd",
      "adam",
      "rmsprop",
    ]);
  });

  test("a categorical or unknown color column has no gradient to follow", () => {
    expect(orientationFor(trials(), "optimizer")).toBe(NO_ORIENTATION);
    expect(orientationFor(trials(), "missing")).toBe(NO_ORIENTATION);
  });

  test("an axis with a single value is left as it is", () => {
    const rows = trials().map((row) => ({ ...row, lr: 0.1 }));
    expect(orientationFor(rows, "accuracy").inverted.has("lr")).toBe(false);
  });
});
