import { describe, expect, test } from "bun:test";
import {
  type ColumnChoice,
  entryOption,
  filteredActive,
  matchingColumns,
  movedActive,
  pickerOptions,
} from "./columnpicker";

const columns = [
  { name: "lr", label: "Learning rate" },
  { name: "val_loss", label: "val_loss" },
  { name: "train_loss", label: "train_loss" },
];

const several = (chosen: string[]): ColumnChoice => ({
  kind: "several",
  chosen: new Set(chosen),
  onShow: () => undefined,
  onHide: () => undefined,
});
const one = (chosen: string | null): ColumnChoice => ({
  kind: "one",
  chosen,
  onPick: () => undefined,
});

describe("filtering", () => {
  test("an empty filter keeps every column in order", () => {
    expect(matchingColumns(columns, "  ")).toEqual(columns);
  });

  test("every term must appear in the name or the label, ignoring case", () => {
    expect(matchingColumns(columns, "LOSS val").map((column) => column.name)).toEqual(["val_loss"]);
    expect(matchingColumns(columns, "rate").map((column) => column.name)).toEqual(["lr"]);
    expect(matchingColumns(columns, "momentum")).toEqual([]);
  });
});

describe("options", () => {
  test("several columns are picked from the matches alone", () => {
    expect(pickerOptions(columns, "several", "loss").map((option) => option.name)).toEqual([
      "val_loss",
      "train_loss",
    ]);
  });

  test("a single choice always offers None first, whatever the filter", () => {
    expect(pickerOptions(columns, "one", "loss").map((option) => option.name)).toEqual([
      null,
      "val_loss",
      "train_loss",
    ]);
    expect(pickerOptions(columns, "one", "momentum")).toEqual([{ name: null, label: "None" }]);
  });

  test("the keyboard enters a single choice at its column, or at None when it has none", () => {
    expect(entryOption(pickerOptions(columns, "one", ""), one("train_loss"))).toBe(3);
    expect(entryOption(pickerOptions(columns, "one", ""), one(null))).toBe(0);
  });

  test("the keyboard enters several columns at the top", () => {
    expect(entryOption(pickerOptions(columns, "several", ""), several(["train_loss"]))).toBe(0);
  });

  test("a filter makes its first matching column active, never None", () => {
    expect(filteredActive(pickerOptions(columns, "one", "loss"), "loss")).toBe(1);
    expect(filteredActive(pickerOptions(columns, "several", "loss"), "loss")).toBe(0);
    expect(filteredActive(pickerOptions(columns, "one", "momentum"), "momentum")).toBeNull();
    expect(filteredActive(pickerOptions(columns, "one", " "), " ")).toBeNull();
  });
});

describe("keyboard", () => {
  test("the first move enters the list at its entry, whichever way it goes", () => {
    expect(movedActive(null, "ArrowDown", 5, 2)).toBe(2);
    expect(movedActive(null, "ArrowUp", 5, 2)).toBe(2);
    expect(movedActive(null, "PageDown", 2, 3)).toBe(1);
  });

  test("arrows move one option and stop at the ends", () => {
    expect(movedActive(0, "ArrowDown", 3, 0)).toBe(1);
    expect(movedActive(2, "ArrowDown", 3, 0)).toBe(2);
    expect(movedActive(1, "ArrowUp", 3, 0)).toBe(0);
    expect(movedActive(0, "ArrowUp", 3, 0)).toBe(0);
  });

  test("PageUp and PageDown move by a page and stop at the ends", () => {
    expect(movedActive(0, "PageDown", 20, 0)).toBe(8);
    expect(movedActive(15, "PageDown", 20, 0)).toBe(19);
    expect(movedActive(10, "PageUp", 20, 0)).toBe(2);
    expect(movedActive(3, "PageUp", 20, 0)).toBe(0);
  });

  test("other keys and empty lists leave the active option alone", () => {
    expect(movedActive(1, "a", 3, 0)).toBeNull();
    expect(movedActive(null, "Enter", 3, 0)).toBeNull();
    expect(movedActive(0, "ArrowDown", 0, 0)).toBeNull();
  });
});
