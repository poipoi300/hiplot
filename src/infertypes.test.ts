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
  test("columns without finite numbers render categorically and warn", () => {
    for (const values of [
      [null],
      [undefined],
      [NaN, Infinity, -Infinity],
      ["", "NA", "N/A", "null", "None", "nan", "inf", "-inf"],
    ]) {
      const warnings: string[] = [];
      const pd = infertypes(
        new PersistentStateInMemory("", {}),
        rows("load_checkpoint", values),
        {},
        (message) => warnings.push(message),
      ).load_checkpoint;
      expect(pd.type).toBe(ParamType.CATEGORICAL);
      expect(pd.type_options).toEqual([ParamType.CATEGORICAL]);
      expect(pd.distinct_values).toEqual(
        Array.from(new Set(values.filter((value) => value !== undefined))),
      );
      expect(create_d3_scale(pd).kind).toBe("categorical");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Column "load_checkpoint"');
      expect(warnings[0]).toContain("no finite numeric values");
    }
  });

  test("unusable saved scales fall back to a supported type and warn", () => {
    for (const [values, requested, expected] of [
      [["checkpoint.pt", "latest.pt"], ParamType.NUMERIC, ParamType.CATEGORICAL],
      [[null, "NA"], ParamType.NUMERICPERCENTILE, ParamType.CATEGORICAL],
      [[null], ParamType.TIMESTAMP, ParamType.CATEGORICAL],
      [[-1, 0, 1], ParamType.NUMERICLOG, ParamType.NUMERIC],
    ] as const) {
      const warnings: string[] = [];
      const state = new PersistentStateInMemory("", { "x.type": requested });
      const pd = infertypes(state, rows("x", [...values]), {}, (message) =>
        warnings.push(message),
      ).x;
      expect(pd.type).toBe(expected);
      expect(pd.type_options).not.toContain(requested);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Column "x"');
      expect(create_d3_scale(pd).paramType).toBe(expected);
      expect(state.children("x").get("type")).toBe(requested);
    }
  });

  test("a temporarily unusable numeric column regains its scale when rows are restored", () => {
    const state = new PersistentStateInMemory("", {});
    const allRows = rows("x", [1, 2, 3, null]);
    const original = infertypes(state, allRows);
    const filtered = infertypes(state, [allRows[3]], original);
    expect(filtered.x.type).toBe(ParamType.CATEGORICAL);
    const restored = infertypes(state, allRows, filtered);
    expect(restored.x.type).toBe(ParamType.NUMERIC);
    expect(create_d3_scale(restored.x).kind).toBe("continuous");
  });

  test("explicit categorical missing-value columns do not warn", () => {
    const warnings: string[] = [];
    const state = new PersistentStateInMemory("", { "x.type": ParamType.CATEGORICAL });
    const pd = infertypes(state, rows("x", [null]), {}, (message) => warnings.push(message)).x;
    expect(pd.type).toBe(ParamType.CATEGORICAL);
    expect(warnings).toEqual([]);
  });

  test("finite explicit bounds keep numeric scales usable without finite samples", () => {
    for (const type of [ParamType.NUMERIC, ParamType.NUMERICLOG, ParamType.TIMESTAMP]) {
      const warnings: string[] = [];
      const hint = { ...infer("x", [null]), type, force_value_min: 1, force_value_max: 10 };
      const pd = infertypes(
        new PersistentStateInMemory("", {}),
        rows("x", [null]),
        { x: { ...hint, type_requested: type } },
        (message) => warnings.push(message),
      ).x;
      expect(pd.type).toBe(type);
      const scale = create_d3_scale(pd);
      expect(scale.kind === "continuous" && scale.domain()).toEqual([1, 10]);
      expect(warnings).toEqual([]);
    }
  });

  test("percentile scales need samples even when explicit bounds exist", () => {
    const hint = {
      ...infer("x", [null]),
      type: ParamType.NUMERICPERCENTILE,
      type_requested: ParamType.NUMERICPERCENTILE,
      force_value_min: 1,
      force_value_max: 10,
    };
    const warnings: string[] = [];
    const pd = infertypes(
      new PersistentStateInMemory("", {}),
      rows("x", [null]),
      { x: hint },
      (message) => warnings.push(message),
    ).x;
    expect(create_d3_scale(pd).kind).toBe("categorical");
    expect(pd.type_options).not.toContain(ParamType.NUMERICPERCENTILE);
    expect(warnings).toHaveLength(1);
  });

  test("numeric uids make a numeric column, as a trial index", () => {
    const table = rows(
      "loss",
      range(300, (i) => i),
    );
    const pd = infertypes(new PersistentStateInMemory("", {}), table).uid;
    expect(pd.type).toBe(ParamType.NUMERIC);
    expect(pd.numeric).toBe(true);
    expect(pd.distinct_values).toHaveLength(300);
  });

  test("uids that are not numbers stay categorical, and from_uid always does", () => {
    const table: Datapoint[] = [
      { uid: "run_a", from_uid: null, loss: 1 },
      { uid: "run_b", from_uid: "1", loss: 2 },
      { uid: "run_c", from_uid: "2", loss: 3 },
    ];
    const defs = infertypes(new PersistentStateInMemory("", {}), table);
    expect(defs.uid.type).toBe(ParamType.CATEGORICAL);
    expect(defs.from_uid.numeric).toBe(false);
    expect(defs.from_uid.type).toBe(ParamType.CATEGORICAL);
  });

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

  test("text numbers with nan, inf and blank cells stay numeric (a CSV of diverged trials)", () => {
    const accuracies = range(60, (i) => i / 100).map(String);
    const pd = infer("val_accuracy", [...accuracies, "nan", "nan", "inf", "-Infinity", "NaN", ""]);
    expect(pd.numeric).toBe(true);
    expect(pd.type).toBe(ParamType.NUMERIC);
    const scale = create_d3_scale(pd);
    expect(scale.kind === "continuous" && scale.hasOutlierBand).toBe(true);
  });

  test("text numbers with NA, N/A, null and None cells are numeric with missing values", () => {
    const accuracies = range(60, (i) => i / 100).map(String);
    const pd = infer("val_accuracy", [...accuracies, "NA", "n/a", "null", "None", "NULL"]);
    expect(pd.numeric).toBe(true);
    expect(pd.type).toBe(ParamType.NUMERIC);
    const scale = create_d3_scale(pd);
    expect(scale.kind === "continuous" && scale.hasOutlierBand).toBe(true);
  });

  test("missing-value spellings beside real text leave the column categorical", () => {
    const optimizers = range(30, (i) => i).map((i) => (i % 2 === 0 ? "adam" : "sgd"));
    const pd = infer("optimizer", [...optimizers, "NA", "None"]);
    expect(pd.numeric).toBe(false);
    expect(pd.type).toBe(ParamType.CATEGORICAL);
  });

  test("hexadecimal text is not a number spelling, so its column is categorical", () => {
    expect(
      infer(
        "id",
        range(30, (i) => i).map((i) => `0x${i.toString(16)}`),
      ).numeric,
    ).toBe(false);
  });

  test("positive values spanning orders of magnitude get a log axis", () => {
    const pd = infer(
      "lr",
      range(40, (i) => 10 ** (i / 5 - 4)),
    );
    expect(pd.type).toBe(ParamType.NUMERICLOG);
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
