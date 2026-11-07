import { describe, expect, test } from "bun:test";
import * as d3 from "d3";
import {
  continuousFromD3,
  convert_to_categorical_input,
  d3_scale_categorical,
  d3_scale_percentile,
  d3_scale_timestamp,
  get_numeric_values_sorted,
  getLogScaleTickValues,
  is_special_numeric,
  naturalSortComparator,
  scale_add_outliers,
} from "./d3_scales";

describe("special numerics", () => {
  test("inf, nan, null and empty strings are special, finite numbers are not", () => {
    for (const value of ["inf", "-inf", Infinity, -Infinity, null, "", "NaN", NaN]) {
      expect(is_special_numeric(value)).toBe(true);
    }
    for (const value of [0, 1.5, "1.5", "abc", undefined]) {
      expect(is_special_numeric(value)).toBe(false);
    }
  });
});

describe("categorical scale", () => {
  test("orders categories naturally so 10 comes after 9", () => {
    const scale = d3_scale_categorical(["10", "9", "1", "b", "a"]);
    expect(scale.domain()).toEqual(["1", "9", "10", "a", "b"]);
  });

  test("maps the empty string to its own (empty) category", () => {
    expect(convert_to_categorical_input("")).toBe("(empty)");
    expect(d3_scale_categorical(["", "x"]).domain()).toEqual(["(empty)", "x"]);
  });

  test("spreads categories evenly over the range and maps unknowns to NaN", () => {
    const scale = d3_scale_categorical(["a", "b", "c"]).range([0, 100]);
    expect(scale("a")).toBe(0);
    expect(scale("b")).toBe(50);
    expect(scale("c")).toBe(100);
    expect(scale("zzz")).toBeNaN();
  });

  test("copies are independent of the original range", () => {
    const scale = d3_scale_categorical(["a", "b"]).range([0, 10]);
    const copy = scale.copy().range([0, 20]);
    expect(scale("b")).toBe(10);
    expect(copy("b")).toBe(20);
  });

  test("natural sort compares digit runs numerically", () => {
    expect(["x10", "x2", "x1"].sort(naturalSortComparator)).toEqual(["x1", "x2", "x10"]);
  });
});

describe("numeric helpers", () => {
  test("sorted numeric values drop duplicates and non-finite values", () => {
    expect(get_numeric_values_sorted([3, "1", 2, 3, "inf", NaN, "x"])).toEqual([1, 2, 3]);
  });

  test("log ticks are powers of ten inside the domain, thinned to the requested count", () => {
    expect(getLogScaleTickValues([0.5, 2000], 10)).toEqual([1, 10, 100, 1000]);
    expect(getLogScaleTickValues([1e-6, 1e6], 3)).toEqual([1e-6, 1e-1, 1e4, 1e6]);
    expect(getLogScaleTickValues([2, 3], 5)).toBeNull();
    expect(getLogScaleTickValues([-1, 10], 5)).toBeNull();
  });
});

describe("continuous scales", () => {
  test("wrapped d3 scales coerce strings the way d3 does", () => {
    const scale = continuousFromD3(d3.scaleLinear().domain([0, 10])).range([0, 100]);
    expect(scale("5")).toBe(50);
    expect(scale.invert(25)).toBe(2.5);
    expect(scale.domain()).toEqual([0, 10]);
  });

  test("percentile scale maps each distinct value to its rank", () => {
    const scale = d3_scale_percentile([1, 10, 100, 1000, 10000]).range([0, 4]);
    expect(scale(1)).toBe(0);
    expect(scale(100)).toBe(2);
    expect(scale(10000)).toBe(4);
    expect(scale(55)).toBeCloseTo(1.5);
    expect(scale.invert(3)).toBe(1000);
    // Non-finite values land one full range before the start, off the axis.
    expect(scale(Infinity)).toBe(-4);
  });

  test("percentile scale ticks stay inside the domain and format compactly", () => {
    const scale = d3_scale_percentile([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]).range([0, 1]);
    const ticks = scale.ticks(3);
    expect(ticks.length).toBeGreaterThan(0);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0.1);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(0.6);
    expect(scale.tickFormat()(0.25)).toBe("0.25");
  });

  test("timestamp scale works in seconds", () => {
    const scale = d3_scale_timestamp().domain([0, 100]).range([0, 1000]);
    expect(scale(50)).toBe(500);
    expect(scale(new Date(50_000))).toBe(500);
    expect(scale.invert(250)).toBe(25);
    expect(scale.domain()).toEqual([0, 100]);
  });
});

describe("outlier band", () => {
  const base = () => continuousFromD3(d3.scaleLinear().domain([0, 10]));

  test("special values sit at the end of the range, finite values in the rest", () => {
    const scale = scale_add_outliers(base()).range([130, 0]);
    expect(scale("inf")).toBe(0);
    expect(scale(null)).toBe(0);
    expect(scale(0)).toBe(130);
    // 30 pixels are reserved for the band, so 10 lands at 130 - 100.
    expect(scale(10)).toBe(30);
    expect(scale.hasOutlierBand).toBe(true);
  });

  test("ticks add a NaN tick labelled for the band", () => {
    const scale = scale_add_outliers(base()).range([130, 0]);
    const ticks = scale.ticks(5);
    expect(ticks[ticks.length - 1]).toBeNaN();
    expect(scale.tickFormat(5)(Number.NaN)).toBe("nan/inf/null");
  });

  test("inverting inside the band selects beyond the domain", () => {
    const scale = scale_add_outliers(base()).range([0, 130]);
    expect(scale.invert(120)).toBeCloseTo(11);
    expect(scale.invert(50)).toBe(5);
  });
});
