# One-axis plot (distribution)

This page explains how HiPlot draws the distribution of one column. It is a
scatter panel with only X set: pick X alone in a scatter panel, or choose
**View distribution** in a column's right-click menu, which opens (or reuses)
such a panel. There is no separate Distributions section any more; pages
saved with distribution plots, and `exp.display_data(hip.Displays.DISTRIBUTION)`
with an `axis`, open one-axis panels instead, and its `nbins` sets their bins.

## Key files

- `src/distribution/plugin.tsx`: `DistributionView`, the one-axis plot of a scatter panel.
- `src/distribution/plot.tsx`: histogram binning, axis layout, and SVG rendering.
- `src/distribution/fit.ts`, `src/stats/distributions.ts`: the fitted density.

## Fitted density

For numeric columns the plot draws, over the selected rows' histogram, the
distribution that fits the selection best by BIC among normal, log-normal,
exponential and gamma (positive values), beta (values in (0, 1)) and
Student t, plus a dashed kernel density estimate for reference; on a log
axis the estimate smooths ln(x), so its bandwidth follows the axis. The caption
states the winner with its fitted parameters and formula, the runner-up and
its ΔBIC. Beyond 5,000 values an evenly spaced sample is fitted.

A row hovered anywhere on the page is marked across the plot in its color.

## Data sources

For the selected axis, the plot renders two distributions:

- **Selected** rows (`rows_selected`): purple filled bars.
- **Filtered** rows (`rows_filtered`): black line segments.

In other words, the black series is the current filtered-on-screen population, not necessarily the original unfiltered dataset.

## Orientation

`DistributionPlot.isVertical()` chooses layout:

- **Vertical** for numeric axes, and for categorical axes with fewer than 3 values.
- **Horizontal** for categorical axes with 3 or more values.

## Binning strategy

`DistributionPlot.createHistogram()` builds normalized bins in `[0, 1]`.

Numeric axes:

- Value mapping uses the axis scale remapped to `[0, 1]`.
- Thresholds are `1/nbins, 2/nbins, ..., (nbins-1)/nbins`.

Categorical axes:

- Categories are mapped by domain index.
- Category `idx` maps to center `(idx + 0.5) / domainCount`.
- Thresholds are `i / domainCount` for `i = 1..domainCount-1`.
- This produces equal-width categorical bins.

## Density scaling

Each series is plotted as relative density within that series:

- `density = bin_count / total_count_for_that_series`

The y-axis (or x-axis in horizontal mode) uses the maximum density across both series for a shared visual scale.

## Categorical ordering in horizontal mode

When horizontal categorical mode is active:

- Categories are reordered by selected-bin count (ascending).
- Ties are resolved by original category index for deterministic ordering.
- The same ordering is applied to both selected and filtered series, and to axis labels.

## Behavior notes

- The black series is filtered population, not full raw population.
- Because densities are normalized per series, bar/line heights are proportionate within each series rather than absolute counts across series.
- Categories absent from the current axis domain are ignored during histogram binning.
