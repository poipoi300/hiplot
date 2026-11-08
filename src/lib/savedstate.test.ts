import { afterEach, describe, expect, test } from "bun:test";
import {
  isNumber,
  isStringArray,
  PersistentStateInMemory,
  PersistentStateInURL,
  ReportingPersistentState,
  readState,
} from "./savedstate";

afterEach(() => {
  history.replaceState({}, "", "?");
});

describe("in-memory state", () => {
  test("children namespace their keys under the parent prefix", () => {
    const params: { [key: string]: unknown } = {};
    const root = new PersistentStateInMemory("", params);
    root.children("PARALLEL_PLOT").set("height", 400);
    expect(params).toEqual({ "PARALLEL_PLOT.height": 400 });
    expect(root.children("PARALLEL_PLOT").get("height")).toBe(400);
    expect(root.get("missing", "fallback")).toBe("fallback");
  });

  test("clear only removes the child's keys", () => {
    const params: { [key: string]: unknown } = { "a.x": 1, "b.x": 2 };
    new PersistentStateInMemory("", params).children("a").clear();
    expect(params).toEqual({ "b.x": 2 });
  });
});

describe("URL state", () => {
  test("values round-trip through the query string as JSON", () => {
    const state = new PersistentStateInURL("hip");
    state.children("PARALLEL_PLOT").set("order", ["b", "a"]);
    expect(new URLSearchParams(location.search).get("hip.PARALLEL_PLOT.order")).toBe('["b","a"]');
    expect(new PersistentStateInURL("hip").children("PARALLEL_PLOT").get("order")).toEqual([
      "b",
      "a",
    ]);
  });

  test("unparseable values fall back to the default", () => {
    history.replaceState({}, "", "?hip.height=%7Bnot-json");
    expect(new PersistentStateInURL("hip").get("height", 600)).toBe(600);
  });
});

describe("validated reads", () => {
  test("readState returns stored values of the right shape and the fallback otherwise", () => {
    const state = new PersistentStateInMemory("", { order: ["x"], height: "tall" });
    expect(readState(state, "order", isStringArray, [])).toEqual(["x"]);
    expect(readState(state, "height", isNumber, 600)).toBe(600);
    expect(readState(state, "missing", isNumber, 1)).toBe(1);
  });
});

describe("reporting unusable stored values", () => {
  test("a stored value of the wrong shape falls back and is reported with its full key", () => {
    const params: { [key: string]: unknown } = { "PARALLEL_PLOT.order": "lr" };
    const reported: [string, unknown][] = [];
    const root = new ReportingPersistentState(
      new PersistentStateInMemory("", params),
      (key, value) => reported.push([key, value]),
    );
    const plot = root.children("PARALLEL_PLOT");
    expect(readState(plot, "order", isStringArray, ["x"])).toEqual(["x"]);
    expect(reported).toEqual([["PARALLEL_PLOT.order", "lr"]]);
  });

  test("a missing value falls back silently and a valid one is read through", () => {
    const params: { [key: string]: unknown } = { height: 300 };
    const reported: string[] = [];
    const root = new ReportingPersistentState(new PersistentStateInMemory("", params), (key) =>
      reported.push(key),
    );
    expect(readState(root, "width", isNumber, 10)).toBe(10);
    expect(readState(root, "height", isNumber, 10)).toBe(300);
    root.set("width", 20);
    expect(params.width).toBe(20);
    expect(reported).toEqual([]);
  });
});
