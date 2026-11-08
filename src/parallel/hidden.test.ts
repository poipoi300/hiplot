import { expect, test } from "bun:test";
import { defaultHiddenColumns } from "./hidden";

test("the uid is hidden by default, along with what the experiment hides", () => {
  expect(defaultHiddenColumns([], [])).toEqual(["uid"]);
  expect(defaultHiddenColumns(["params"], ["lr", "loss"])).toEqual(["params", "uid"]);
});

test("an experiment that places the uid in its axis order shows it", () => {
  expect(defaultHiddenColumns(["params"], ["lr", "uid", "loss"])).toEqual(["params"]);
});

test("an experiment that hides the uid itself keeps its own list", () => {
  expect(defaultHiddenColumns(["uid", "params"], [])).toEqual(["uid", "params"]);
});
