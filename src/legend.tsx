/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import style from "./hiplot.module.css";
import {
  COLOR_MODES,
  type ColorBinning,
  type ColorMode,
  type ColorTheme,
  NUMERIC_COLOR_MAPS,
  type NumericColorMap,
  type RGB,
  themedColorMap,
} from "./lib/colors";
import { labelTextFromHtml } from "./lib/escape";
import { columnNotation, formatterFor } from "./lib/numberformat";
import { Popover } from "./lib/popover";

/** Categories listed before the legend summarizes the rest. */
const MAX_LISTED_CATEGORIES = 8;
/** Color stops of the numeric gradient; the bins are finer than the eye can tell apart. */
const GRADIENT_STOPS = 16;

const css = ({ r, g, b }: RGB): string => `rgb(${r}, ${g}, ${b})`;

/** A CSS gradient through `stops` samples of a color map. */
function gradientOf(colorAt: (t: number) => string, stops: number): string {
  return `linear-gradient(to right, ${Array.from({ length: stops }, (_, i) => colorAt(i / (stops - 1))).join(", ")})`;
}

const CHEVRON = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

/** How each color mode reads in the picker, and what it does. */
const COLOR_MODE_LABELS: Record<ColorMode, { label: string; badge: string; title: string }> = {
  mean: {
    label: "Mean value",
    badge: "",
    title: "Where lines overlap, show the color of their mean value",
  },
  lowest: {
    label: "Lowest on top",
    badge: "lowest on top",
    title: "Where lines overlap, show the line with the lowest value on top",
  },
  highest: {
    label: "Highest on top",
    badge: "highest on top",
    title: "Where lines overlap, show the line with the highest value on top",
  },
};

interface ColorMapPickerProps {
  /** The color map in effect, a d3 interpolator name. */
  colorMap: string;
  /** What overlapping lines show. */
  colorMode: ColorMode;
  theme: ColorTheme;
  onPick: (id: string) => void;
  onPickMode: (mode: ColorMode) => void;
}

/**
 * Picks the color map of numeric color-by columns, previewing each on the
 * current theme, and what overlapping lines show. A mode other than the mean
 * is named on the button, since it changes what the plot means.
 */
function ColorMapPicker({
  colorMap,
  colorMode,
  theme,
  onPick,
  onPickMode,
}: ColorMapPickerProps): React.ReactElement {
  const current = NUMERIC_COLOR_MAPS.find((map) => map.id === colorMap);
  const badge = COLOR_MODE_LABELS[colorMode].badge;
  const option = (map: NumericColorMap, close: () => void) => {
    const colorAt = themedColorMap(map.id, theme);
    if (colorAt === null) {
      throw new Error(`Color map ${map.id} has no definition`);
    }
    return (
      <label key={map.id} className={style.colorMapOption}>
        <input
          type="radio"
          name="hiplot-color-map"
          checked={map.id === colorMap}
          onChange={() => {
            onPick(map.id);
            close();
          }}
        />
        <span className={style.colorMapSwatch} style={{ background: gradientOf(colorAt, 12) }} />
        {map.label}
      </label>
    );
  };
  return (
    <Popover
      trigger={
        <>
          {current?.label ?? "Custom"}
          {badge !== "" && <span className={style.colorModeBadge}>· {badge}</span>}
          {CHEVRON}
        </>
      }
      label="Color map"
      title="Choose the color map of numeric columns and what overlapping lines show"
      align="start"
      testId="color-map-button"
    >
      {(close) => (
        <>
          <fieldset className={style.colorMapGroup}>
            <legend className={style.colorMapKind}>Overlapping lines</legend>
            {COLOR_MODES.map((mode) => (
              <label
                key={mode}
                className={style.colorMapOption}
                title={COLOR_MODE_LABELS[mode].title}
              >
                <input
                  type="radio"
                  name="hiplot-color-mode"
                  checked={mode === colorMode}
                  onChange={() => {
                    onPickMode(mode);
                    close();
                  }}
                />
                {COLOR_MODE_LABELS[mode].label}
              </label>
            ))}
          </fieldset>
          {(["sequential", "diverging"] as const).map((kind) => (
            <fieldset key={kind} className={style.colorMapGroup}>
              <legend className={style.colorMapKind}>
                {kind === "sequential" ? "Sequential" : "Diverging"}
              </legend>
              {NUMERIC_COLOR_MAPS.filter((map) => map.kind === kind).map((map) =>
                option(map, close),
              )}
            </fieldset>
          ))}
        </>
      )}
    </Popover>
  );
}

interface ColorLegendProps {
  binning: ColorBinning;
  /** Whether some rows are drawn in the missing color, which then gets an entry. */
  hasMissing: boolean;
  /** The color-by column's name and its HTML label. */
  column: string;
  labelHtml: string;
  /** The numeric color map in effect, the theme, and where a picked one goes. */
  colorMap: string;
  theme: ColorTheme;
  onPickColorMap: (id: string) => void;
  /** What overlapping lines show for a numeric column, and where a picked mode goes. */
  colorMode: ColorMode;
  onPickColorMode: (mode: ColorMode) => void;
}

/** What color means: the color-by column with its categories or its value range. */
export function ColorLegend({
  binning,
  hasMissing,
  column,
  labelHtml,
  colorMap,
  theme,
  onPickColorMap,
  colorMode,
  onPickColorMode,
}: ColorLegendProps): React.ReactElement {
  const legend = binning.legend;
  const title = labelTextFromHtml(labelHtml, column);
  return (
    <div className={style.legend} data-testid="color-legend">
      <span className={style.legendTitle}>
        Color <span className={style.legendColumn}>{title}</span>
      </span>
      {legend.kind === "categorical" ? (
        <ul className={style.legendCategories}>
          {legend.categories.slice(0, MAX_LISTED_CATEGORIES).map((category, bin) => (
            <li key={category}>
              <span
                className={style.legendSwatch}
                style={{ background: css(binning.palette[bin]) }}
              />
              {category}
            </li>
          ))}
          {legend.categories.length > MAX_LISTED_CATEGORIES && (
            <li className={style.legendMore}>
              +{legend.categories.length - MAX_LISTED_CATEGORIES} more
            </li>
          )}
        </ul>
      ) : (
        <span className={style.legendScale}>
          <span>{formatterFor(columnNotation(legend.domain))(legend.domain[0])}</span>
          <span
            className={style.legendGradient}
            style={{
              background: `linear-gradient(to right, ${Array.from(
                { length: GRADIENT_STOPS },
                (_, i) =>
                  css(
                    binning.palette[
                      Math.round((i / (GRADIENT_STOPS - 1)) * (binning.missingBin - 1))
                    ],
                  ),
              ).join(", ")})`,
            }}
          />
          <span>{formatterFor(columnNotation(legend.domain))(legend.domain[1])}</span>
          <ColorMapPicker
            colorMap={colorMap}
            colorMode={colorMode}
            theme={theme}
            onPick={onPickColorMap}
            onPickMode={onPickColorMode}
          />
        </span>
      )}
      {hasMissing && (
        <span className={style.legendMissing}>
          <span
            className={style.legendSwatch}
            style={{ background: css(binning.palette[binning.missingBin]) }}
          />
          missing
        </span>
      )}
    </div>
  );
}
