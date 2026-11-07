import { describe, expect, test } from "bun:test";
import { infertypes, type ParamDef } from "../infertypes";
import { type Datapoint, type DatapointValue, ParamType } from "../types";
import { colorBinning, NUMERIC_COLOR_BINS, parseColorMap } from "./colors";
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
  test("each category gets its own bin, unknown values the grey missing bin", () => {
    const binning = colorBinning(column(["a", "b", "a"]), null);
    expect(binning.binOf("a")).toBe(0);
    expect(binning.binOf("b")).toBe(1);
    expect(binning.binOf("zzz")).toBe(binning.missingBin);
    expect(binning.palette[binning.missingBin]).toEqual({ r: 100, g: 100, b: 100 });
  });

  test("user colors win over the palette and are not mutated", () => {
    const colors = { a: "rgb(1, 2, 3)" };
    const pd: ParamDef = { ...column(["a", "b"]), colors };
    expect(colorBinning(pd, null).css(0, 1)).toBe("rgba(1, 2, 3, 1)");
    expect(colors).toEqual({ a: "rgb(1, 2, 3)" });
  });

  test("css strings carry the requested opacity", () => {
    const binning = colorBinning(column(["a", "b"]), null);
    expect(binning.css(0, 0.25)).toBe("rgba(31, 119, 180, 0.25)");
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
