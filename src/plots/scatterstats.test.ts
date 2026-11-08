import { describe, expect, test } from "bun:test";
import { type Datapoint, ParamType } from "../types";
import { fitSpaceValue, fromFitSpace, scatterStats } from "./scatterstats";

const rows = (values: Array<{ [column: string]: number | string }>): Datapoint[] =>
  values.map((value, index) => ({ uid: `${index}`, from_uid: null, ...value }));

const numeric = (column: string) => ({ column, type: ParamType.NUMERIC });
const log = (column: string) => ({ column, type: ParamType.NUMERICLOG });
const categorical = (column: string) => ({ column, type: ParamType.CATEGORICAL });

describe("scatter statistics", () => {
  test("two numeric columns get correlations and a straight fit through their points", () => {
    const data = rows(Array.from({ length: 20 }, (_, i) => ({ a: i, b: 3 + 2 * i })));
    const stats = scatterStats(data, numeric("a"), numeric("b"), "linear");
    if (stats.kind !== "numeric" || stats.fit?.mode !== "linear") {
      throw new Error("Expected a straight fit");
    }
    expect(stats.summary.n).toBe(20);
    expect(stats.summary.pearson).toBeCloseTo(1);
    expect(stats.summary.spearman).toBeCloseTo(1);
    expect(stats.fit.slope).toBeCloseTo(2);
    expect(stats.fit.points[0]).toEqual([0, 3]);
    expect(stats.fit.points[stats.fit.points.length - 1][1]).toBeCloseTo(41);
  });

  test("log axes are fitted in log space and the fit comes back as values", () => {
    // y = x^2 is a straight line of slope 2 in log-log space.
    const data = rows([1, 10, 100, 1000].map((value) => ({ a: value, b: value ** 2 })));
    const stats = scatterStats(data, log("a"), log("b"), "linear");
    if (stats.kind !== "numeric" || stats.fit?.mode !== "linear") {
      throw new Error("Expected a straight fit");
    }
    expect(stats.logX && stats.logY).toBe(true);
    expect(stats.fit.slope).toBeCloseTo(2);
    const [x, y] = stats.fit.points[stats.fit.points.length - 1];
    expect(x).toBeCloseTo(1000);
    expect(y).toBeCloseTo(1e6, -2);
  });

  test("binned means follow a curve a straight line misses", () => {
    const data = rows(Array.from({ length: 240 }, (_, i) => ({ a: i / 24, b: (i / 24) ** 2 })));
    const stats = scatterStats(data, numeric("a"), numeric("b"), "binned");
    if (stats.kind !== "numeric" || stats.fit?.mode !== "binned") {
      throw new Error("Expected binned means");
    }
    expect(stats.fit.points).toHaveLength(12);
    for (const [x, y] of stats.fit.points) {
      expect(y).toBeCloseTo(x * x, 0);
    }
  });

  test("a category against a number gets the number's mean per category with an interval", () => {
    const data = rows([
      { opt: "sgd", loss: 1 },
      { opt: "sgd", loss: 3 },
      { opt: "adam", loss: 10 },
      { opt: "adam", loss: 12 },
      { opt: "adam", loss: 14 },
      { opt: "adam", loss: "inf" },
    ]);
    const stats = scatterStats(data, numeric("loss"), categorical("opt"), "linear");
    if (stats.kind !== "categorical") {
      throw new Error("Expected category means");
    }
    expect(stats.categoriesOn).toBe("y");
    expect(stats.n).toBe(5);
    const adam = stats.means.find((mean) => mean.category === "adam");
    expect(adam?.mean).toBeCloseTo(12);
    expect(adam?.lower).toBeLessThan(12);
    expect(adam?.upper).toBeGreaterThan(12);
  });

  test("two categorical columns have no fit", () => {
    const stats = scatterStats(
      rows([{ a: "x", b: "y" }]),
      categorical("a"),
      categorical("b"),
      "linear",
    );
    expect(stats.kind).toBe("none");
  });

  test("values that cannot be fitted are left out", () => {
    expect(fitSpaceValue(-1, ParamType.NUMERICLOG)).toBeNaN();
    expect(fitSpaceValue("inf", ParamType.NUMERIC)).toBeNaN();
    expect(fitSpaceValue("NA", ParamType.NUMERIC)).toBeNaN();
    expect(fitSpaceValue(null, ParamType.NUMERIC)).toBeNaN();
    expect(fitSpaceValue(true, ParamType.NUMERIC)).toBeNaN();
  });

  test("numbers spelled as text are fitted like numbers", () => {
    expect(fitSpaceValue(" 2.5 ", ParamType.NUMERIC)).toBe(2.5);
    expect(fitSpaceValue("100", ParamType.NUMERICLOG)).toBe(2);
    expect(fromFitSpace(2, ParamType.NUMERICLOG)).toBe(100);
  });
});
