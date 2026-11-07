import { describe, expect, test } from "bun:test";
import { infertypes, type ParamDef } from "../infertypes";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import {
  colorBinning,
  hashedCategoryColor,
  NUMERIC_COLOR_BINS,
  OKABE_ITO,
  parseColorMap,
  TABLEAU_10,
} from "./colors";
import { PersistentStateInMemory } from "./savedstate";

function column(values: DatapointValue[]): ParamDef {
  const rows: Datapoint[] = values.map((value, index) => ({
    uid: `${index}`,
    from_uid: null,
    c: value,
  }));
  return infertypes(new PersistentStateInMemory("", {}), rows).c;
}

const numbers = Array.from({ length: 30 }, (_, i) => i);

describe("categorical color bins", () => {
  test("categories are binned in axis order, unknown values in the grey missing bin", () => {
    const binning = colorBinning(column(["b", "a10", "a2", "b"]), null);
    expect(binning.legend).toEqual({ kind: "categorical", categories: ["a2", "a10", "b"] });
    expect(binning.binOf("a2")).toBe(0);
    expect(binning.binOf("b")).toBe(2);
    expect(binning.binOf("zzz")).toBe(binning.missingBin);
    expect(binning.binOf(undefined)).toBe(binning.missingBin);
  });

  test("up to seven categories use Okabe-Ito, up to ten Tableau 10, more a stable hash", () => {
    const hex = (binning: ReturnType<typeof colorBinning>, bin: number) => {
      const { r, g, b } = binning.palette[bin];
      return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    };
    const names = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    expect(hex(colorBinning(column(names(7)), null), 0)).toBe(OKABE_ITO[0]);
    expect(hex(colorBinning(column(names(10)), null), 9)).toBe(TABLEAU_10[9]);
    const many = colorBinning(column(names(30)), null, "dark");
    expect(hex(many, 0)).toBe(hashedCategoryColor("c0", "dark").toUpperCase());
    expect(hashedCategoryColor("c0", "dark")).toBe(hashedCategoryColor("c0", "dark"));
  });

  test("the missing color follows the theme", () => {
    const light = colorBinning(column(["a"]), null, "light");
    const dark = colorBinning(column(["a"]), null, "dark");
    expect(light.palette[light.missingBin]).not.toEqual(dark.palette[dark.missingBin]);
  });

  test("user colors win over the palette and are not mutated", () => {
    const colors = { a: "rgb(1, 2, 3)" };
    const pd: ParamDef = { ...column(["a", "b"]), colors };
    expect(colorBinning(pd, null).css(0, 1)).toBe("rgba(1, 2, 3, 1)");
    expect(colors).toEqual({ a: "rgb(1, 2, 3)" });
  });

  test("css strings carry the requested opacity", () => {
    const binning = colorBinning(column(["a", "b"]), null);
    expect(binning.css(0, 0.25)).toBe("rgba(0, 114, 178, 0.25)");
  });
});

describe("numeric color bins", () => {
  test("values map onto evenly spaced samples of the color map", () => {
    const binning = colorBinning(column(numbers), "interpolateGreys");
    expect(binning.palette).toHaveLength(NUMERIC_COLOR_BINS + 1);
    expect(binning.binOf(0)).toBe(0);
    expect(binning.binOf(29)).toBe(NUMERIC_COLOR_BINS - 1);
    expect(binning.css(binning.binOf(0), 1)).toBe("rgba(255, 255, 255, 1)");
    expect(binning.css(binning.binOf(29), 1)).toBe("rgba(0, 0, 0, 1)");
  });

  test("viridis is the default and starts lighter on the dark theme", () => {
    const light = colorBinning(column(numbers), null, "light");
    const dark = colorBinning(column(numbers), null, "dark");
    expect(light.css(0, 1)).toBe("rgba(68, 1, 84, 1)");
    expect(dark.palette[0]).not.toEqual(light.palette[0]);
    expect(light.legend).toEqual({ kind: "numeric", domain: [0, 29] });
  });

  test("missing and special values fall in the grey bin", () => {
    const binning = colorBinning(column(numbers), null);
    for (const value of [undefined, null, "inf", Number.NaN]) {
      expect(binning.binOf(value)).toBe(binning.missingBin);
    }
  });

  test("a column's own color map overrides the default", () => {
    const pd: ParamDef = { ...column(numbers), colormap: "interpolateGreys#inverse" };
    expect(colorBinning(pd, "interpolateTurbo").css(0, 1)).toBe("rgba(255, 255, 255, 1)");
  });

  test("percentile columns are colored by rank", () => {
    const pd: ParamDef = { ...column(numbers), type: ParamType.NUMERICPERCENTILE };
    expect(colorBinning(pd, null).binOf(29)).toBe(NUMERIC_COLOR_BINS - 1);
  });
});

describe("color maps", () => {
  test("schemes index by position and the inverse modifier flips them", () => {
    expect(parseColorMap("schemeCategory10", "")(0.99)).toBe("#17becf");
    expect(parseColorMap("interpolateGreys#inverse", "")(1)).toBe(
      parseColorMap("interpolateGreys", "")(-1),
    );
  });

  test("unknown color maps fail loudly", () => {
    expect(() => parseColorMap("interpolateNope", "")).toThrow("Invalid color map");
  });
});
