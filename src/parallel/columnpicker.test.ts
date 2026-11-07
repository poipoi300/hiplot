import { expect, test } from "bun:test";
import { matchingColumns } from "./columnpicker";

const columns = [
  { name: "lr", label: "Learning rate" },
  { name: "val_loss", label: "val_loss" },
  { name: "train_loss", label: "train_loss" },
];

test("an empty filter keeps every column in order", () => {
  expect(matchingColumns(columns, "  ")).toEqual(columns);
});

test("every term must appear in the name or the label, ignoring case", () => {
  expect(matchingColumns(columns, "LOSS val").map((column) => column.name)).toEqual(["val_loss"]);
  expect(matchingColumns(columns, "rate").map((column) => column.name)).toEqual(["lr"]);
  expect(matchingColumns(columns, "momentum")).toEqual([]);
});
