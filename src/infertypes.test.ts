import { describe, expect, test } from "bun:test";
import {
  create_d3_scale,
  infertypes,
  isParamType,
  type ParamDef,
  scale_pixels_range,
} from "./infertypes";
import { PersistentStateInMemory } from "./lib/savedstate";
import { type Datapoint, type DatapointValue, ParamType } from "./types";

function rows(column: string, values: DatapointValue[]): Datapoint[] {
  return values.map((value, index) => ({ uid: `${index}`, from_uid: null, [column]: value }));
}

function infer(
  column: string,
  values: DatapointValue[],
  state = new PersistentStateInMemory("", {}),
): ParamDef {
  return infertypes(state, rows(column, values))[column];
}

const range = (count: number, map: (i: number) => number): number[] =>
  Array.from({ length: count }, (_, i) => map(i));

describe("type inference", () => {
  test("strings make a column categorical and non-numeric", () => {
    const pd = infer("optimizer", ["adam", "sgd", "adam"]);
    expect(pd.type).toBe(ParamType.CATEGORICAL);
    expect(pd.numeric).toBe(false);
    expect(pd.type_options).toEqual([ParamType.CATEGORICAL]);
  });

  test("many distinct numbers make a linear numeric column", () => {
    const pd = infer(
      "loss",
      range(50, (i) => i * 0.5),
    );
    expect(pd.type).toBe(ParamType.NUMERIC);
    expect(pd.type_options).toContain(ParamType.NUMERICPERCENTILE);
  });

  test("few distinct numbers repeated often stay categorical but can be rendered numerically", () => {
    const pd = infer(
      "layers",
      range(100, (i) => i % 3),
    );
    expect(pd.type).toBe(ParamType.CATEGORICAL);
    expect(pd.numeric).toBe(true);
    expect(pd.type_options).toContain(ParamType.NUMERIC);
  });

  test("positive values spanning orders of magnitude get a log axis", () => {
    const pd = infer(
      "lr",
      range(40, (i) => 10 ** (i / 5 - 4)),
    );
    expect(pd.type).toBe(ParamType.NUMERICLOG);
    expect(pd.ticks_format).toBe(".1e");
  });

  test("a forced minimum at zero turns a would-be log axis into a percentile axis", () => {
    const table = rows(
      "score",
      range(40, (i) => 10 ** (i / 5 - 4)),
    );
    const pd = infertypes(new PersistentStateInMemory("", {}), table, {
      score: {
        type: null,
        colors: null,
        colormap: null,
        force_value_min: 0,
        force_value_max: null,
        label_css: null,
        label_html: null,
      },
    }).score;
    expect(pd.type).toBe(ParamType.NUMERICPERCENTILE);
    expect(pd.type_options).not.toContain(ParamType.NUMERICLOG);
  });

  test("non-negative integers can be shown as timestamps", () => {
    const pd = infer(
      "time",
      range(30, (i) => 1_700_000_000 + i * 3600),
    );
    expect(pd.type_options).toContain(ParamType.TIMESTAMP);
  });

  test("missing values mark a column optional", () => {
    expect(infer("x", [1, undefined, 2]).optional).toBe(true);
  });

  test("special numerics do not make a numeric column categorical", () => {
    expect(infer("x", [...range(30, (i) => i), "inf", NaN, null]).numeric).toBe(true);
  });

  test("a hint overrides the inferred type and supplies colors", () => {
    const table = rows("c", ["red", "blue"]);
    const pd = infertypes(new PersistentStateInMemory("", {}), table, {
      c: {
        type: ParamType.CATEGORICAL,
        colors: { red: "rgb(255, 0, 0)" },
        colormap: null,
        force_value_min: null,
        force_value_max: null,
        label_css: "badge",
        label_html: null,
      },
    }).c;
    expect(pd.colors).toEqual({ red: "rgb(255, 0, 0)" });
    expect(pd.label_css).toBe("badge");
  });

  test("a type saved in the persistent state is reused, invalid ones are ignored", () => {
    const state = new PersistentStateInMemory("", { "x.type": ParamType.NUMERICPERCENTILE });
    expect(
      infer(
        "x",
        range(50, (i) => i),
        state,
      ).type,
    ).toBe(ParamType.NUMERICPERCENTILE);
    const junk = new PersistentStateInMemory("", { "x.type": "banana" });
    expect(
      infer(
        "x",
        range(50, (i) => i),
        junk,
      ).type,
    ).toBe(ParamType.NUMERIC);
  });

  test("column labels are HTML-escaped", () => {
    expect(infer("<b>&", [1, 2]).label_html).toBe("&lt;b&gt;&amp;");
  });

  test("param types are recognized from strings", () => {
    expect(isParamType("numericlog")).toBe(true);
    expect(isParamType("banana")).toBe(false);
  });
});

describe("scales from column definitions", () => {
  test("columns with inf or nan get an outlier band", () => {
    const pd = infer("x", [...range(30, (i) => i), "inf"]);
    const scale = create_d3_scale(pd);
    expect(scale.kind === "continuous" && scale.hasOutlierBand).toBe(true);
    expect(scale.paramType).toBe(ParamType.NUMERIC);
  });

  test("a forced range widens the numeric domain", () => {
    const pd: ParamDef = {
      ...infer(
        "x",
        range(30, (i) => i + 10),
      ),
      force_value_min: 0,
    };
    const scale = create_d3_scale(pd);
    expect(scale.kind === "continuous" ? scale.domain() : []).toEqual([0, 39]);
  });

  test("brushed pixels map back to a numeric range and the inf band", () => {
    const pd = infer("x", [...range(11, (i) => i * 10), "inf"]);
    const scale = create_d3_scale(pd).range([130, 0]);
    const selection = scale_pixels_range(scale, [0, 30]);
    expect(selection.type).toBe(ParamType.NUMERIC);
    if (selection.type !== ParamType.CATEGORICAL) {
      expect(selection.include_infnans).toBe(true);
      expect(Math.max(...selection.range)).toBeGreaterThan(100);
    }
  });

  test("brushed pixels on a categorical axis select the categories inside", () => {
    const scale = create_d3_scale(infer("c", ["a", "b", "c", "d"])).range([0, 30]);
    const selection = scale_pixels_range(scale, [5, 21]);
    expect(selection.type === ParamType.CATEGORICAL ? selection.values : []).toEqual(["b", "c"]);
  });
});
