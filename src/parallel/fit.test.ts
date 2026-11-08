import { expect, test } from "bun:test";
import { fitWithMeasure } from "./parallel";

/** Ten pixels per character. */
const measure = (text: string): number => text.length * 10;

test("text that fits is kept whole", () => {
  expect(fitWithMeasure("0.125", 60, measure)).toEqual({ text: "0.125", width: 50 });
});

test("longer text is cut with an ellipsis to the longest prefix that fits", () => {
  expect(fitWithMeasure("dataset_011", 60, measure)).toEqual({ text: "datas…", width: 60 });
});
