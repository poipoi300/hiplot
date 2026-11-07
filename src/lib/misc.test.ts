import { describe, expect, test } from "bun:test";
import { InternMap } from "d3";
import { Experiment } from "../types";
import { uncompress } from "./compress";
import { escapeHtml, escapeRegExp } from "./escape";

describe("escaping", () => {
  test("HTML escaping matches DOM text serialization", () => {
    expect(escapeHtml(`a<b>&c${String.fromCharCode(0xa0)}`)).toBe("a&lt;b&gt;&amp;c&nbsp;");
  });

  test("regex escaping makes every special character literal", () => {
    const special = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q";
    expect(new RegExp(escapeRegExp(special)).test(special)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
  });
});

describe("experiment payloads", () => {
  test("compressed datapoints expand to uid, parent and values", () => {
    expect(
      uncompress({
        columns: ["loss", "opt"],
        rows: [
          ["1", null, 0.5, "adam"],
          [2, "1", 0.1, "sgd"],
        ],
      }),
    ).toEqual([
      { uid: "1", from_uid: null, values: { loss: 0.5, opt: "adam" } },
      { uid: "2", from_uid: "1", values: { loss: 0.1, opt: "sgd" } },
    ]);
  });

  test("experiments from plain rows default uids to the row index", () => {
    const experiment = Experiment.from_iterable([{ x: 1 }, { uid: "p", from_uid: "q", x: 2 }]);
    expect(experiment.datapoints).toEqual([
      { uid: "0", from_uid: null, values: { x: 1 } },
      { uid: "p", from_uid: "q", values: { x: 2 } },
    ]);
  });
});

describe("dependencies", () => {
  test("d3's InternMap interns Date keys by value (no postinstall hotfix)", () => {
    const map = new InternMap<Date, number>([[new Date(0), 1]]);
    expect(map.get(new Date(0))).toBe(1);
  });
});
