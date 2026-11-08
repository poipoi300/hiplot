import { describe, expect, test } from "bun:test";
import * as d3 from "d3";
import type { ParamDef } from "../infertypes";
import { ParamType } from "../types";
import { colorBinning } from "./colors";
import { contrastRatio, fitColor } from "./fitcolor";

const numericColumn: ParamDef = {
  name: "loss",
  type: ParamType.NUMERIC,
  optional: false,
  numeric: true,
  distinct_values: [0, 0.5, 1],
  type_options: [ParamType.NUMERIC],
  label_css: "",
  label_html: "loss",
  colors: null,
  colormap: null,
  force_value_min: null,
  force_value_max: null,
};

const distanceToPalette = (
  color: string,
  palette: ReadonlyArray<{ r: number; g: number; b: number }>,
) =>
  Math.min(
    ...palette.map(({ r, g, b }) => {
      const a = d3.lab(color);
      const c = d3.lab(d3.rgb(r, g, b));
      return Math.hypot(a.l - c.l, a.a - c.a, a.b - c.b);
    }),
  );

describe("the color of fits", () => {
  test("is far from every color of the active color map, on both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const map of ["interpolateViridis", "interpolateTurbo", "interpolateRdBu"]) {
        const palette = colorBinning(numericColumn, null, theme, map).palette;
        const color = fitColor(palette, theme);
        expect(distanceToPalette(color, palette)).toBeGreaterThan(25);
      }
    }
  });

  test("changes with the color map it must avoid", () => {
    const viridis = colorBinning(numericColumn, null, "dark", "interpolateViridis").palette;
    const magentas = [
      { r: 232, g: 51, b: 109 },
      { r: 255, g: 79, b: 216 },
      { r: 155, g: 77, b: 255 },
    ];
    expect(fitColor(magentas, "dark")).not.toBe(fitColor(viridis, "dark"));
  });

  test("stands out from the theme's background", () => {
    expect(contrastRatio(fitColor([], "light"), "#f8f8f6")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(fitColor([], "dark"), "#15181c")).toBeGreaterThanOrEqual(3);
  });
});
