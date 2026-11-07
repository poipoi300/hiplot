import { describe, expect, test } from "bun:test";
import type { HiPlotExperiment } from "../types";
import { experimentDatapoints, experimentRows, uncompressColumnar } from "./compress";

const columnar = {
  uid: ["a", "b", "c"],
  from_uid: [null, "a", null],
  columns: {
    loss: [0.5, { $f: "inf" as const }, { $f: "nan" as const }],
    opt: ["adam", null, "sgd"],
    lr: [null, null, 0.1],
  },
  missing: { opt: [1], lr: [0, 1] },
};

describe("columnar payloads", () => {
  test("rows get one value per column, with non-finite floats decoded", () => {
    const [a, b, c] = uncompressColumnar(columnar);
    expect(a).toEqual({ uid: "a", from_uid: null, values: { loss: 0.5, opt: "adam" } });
    expect(b.from_uid).toBe("a");
    expect(b.values.loss).toBe(Infinity);
    expect(Number.isNaN(c.values.loss)).toBe(true);
  });

  test("absent values are left out, nulls are kept", () => {
    const [, b, c] = uncompressColumnar(columnar);
    expect("opt" in b.values).toBe(false);
    expect("lr" in b.values).toBe(false);
    expect(c.values).toEqual({ loss: Number.NaN, opt: "sgd", lr: 0.1 });
  });
});

describe("experiment datapoints", () => {
  test("every encoding decodes to the same rows", () => {
    const expected = [{ uid: "1", from_uid: null, values: { x: 2 } }];
    const encodings: HiPlotExperiment[] = [
      { datapoints: expected },
      { datapoints_columnar: { uid: ["1"], from_uid: [null], columns: { x: [2] }, missing: {} } },
      { datapoints_compressed: { columns: ["x"], rows: [["1", null, 2]] } },
    ];
    for (const experiment of encodings) {
      expect(experimentDatapoints(experiment)).toEqual(expected);
    }
    expect(experimentDatapoints({})).toEqual([]);
  });

  test("rows are flat and identical for columnar and row payloads", () => {
    const fromColumnar = experimentRows({ datapoints_columnar: columnar });
    const fromRows = experimentRows({ datapoints: uncompressColumnar(columnar) });
    expect(fromColumnar).toEqual(fromRows);
    expect(fromColumnar[0]).toEqual({ uid: "a", from_uid: null, loss: 0.5, opt: "adam" });
    expect("opt" in fromColumnar[1]).toBe(false);
  });
});
