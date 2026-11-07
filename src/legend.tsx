/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import type React from "react";
import style from "./hiplot.module.css";
import type { ColorBinning, RGB } from "./lib/colors";
import { labelTextFromHtml } from "./lib/escape";

/** Categories listed before the legend summarizes the rest. */
const MAX_LISTED_CATEGORIES = 12;
/** Color stops of the numeric gradient; the bins are finer than the eye can tell apart. */
const GRADIENT_STOPS = 16;

const formatValue = (value: number): string =>
  Math.abs(value) >= 1e4 ? d3.format("~s")(value) : d3.format("~r")(Number(value.toPrecision(3)));

const css = ({ r, g, b }: RGB): string => `rgb(${r}, ${g}, ${b})`;

interface ColorLegendProps {
  binning: ColorBinning;
  /** The color-by column's name and its HTML label. */
  column: string;
  labelHtml: string;
}

/** What color means: the color-by column with its categories or its value range. */
export function ColorLegend({ binning, column, labelHtml }: ColorLegendProps): React.ReactElement {
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
          <span>{formatValue(legend.domain[0])}</span>
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
          <span>{formatValue(legend.domain[1])}</span>
        </span>
      )}
      <span className={style.legendMissing}>
        <span
          className={style.legendSwatch}
          style={{ background: css(binning.palette[binning.missingBin]) }}
        />
        missing
      </span>
    </div>
  );
}
