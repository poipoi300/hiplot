# XY Scatter Plot

This page documents HiPlot's XY display (scatter/line plot), rendered by `src/plotxy.tsx`.

## What it shows

The XY display plots filtered datapoints with:

- X coordinate from `axis_x`
- Y coordinate from `axis_y`
- Point color from the current HiPlot color mapping

Depending on your data, the same panel can show:

- **Scatter points** (default behavior)
- **Line segments** connecting parent/child datapoints when `from_uid` relationships are present

## Enabling and axis selection

The XY panel appears when both axes are set.

Typical flow in the UI:

- Right-click a column in the parallel plot
- Choose `Set as X axis` and `Set as Y axis`

The selected axes are persisted through persistent state (`axis_x`, `axis_y`).

## Interactions

- **Brush zoom**: drag in the XY panel to zoom into a rectangular region.
- **Reset zoom**: clear the brush selection.
- **Hover highlighting**: moving over points can highlight parent or child chains.
- **Context menu mode**: switch highlight mode between `parent` and `children`.

## Statistics

Under each XY scatter, a table gives the selected rows' Pearson r, Spearman
ρ and n, and the plot draws a fit of y against x in a color chosen away from
the active color map:

- two numeric columns: a least-squares line, or the means of y in 12 equal
  bins of x (the toggle beside the table);
- a category and a number: the number's mean per category with its 95%
  Student t interval;
- log axes are fitted in log space (log10 of the values).

## 3D scatter

With Z set the panel is a WebGL 3D scatter: drag to turn, right-, middle- or
shift-drag to pan, wheel to zoom (only for wheel gestures that start on the
plot), ctrl-drag or the Select tool to lasso points into the selection,
double-click to reset. A least-squares plane through the selected points,
fitted in axis space, is drawn as a grid, unless an axis is categorical.

## Rendering model

The XY plugin uses layered rendering:

- Base canvas for points/lines
- Highlight canvas for emphasized rows
- SVG overlay for axes, labels, and brush UI

This keeps interaction responsive for larger datasets while preserving vector-quality axis text.

## Display configuration

Display-level settings are provided through `exp.display_data(hip.Displays.XY)`.

Key options include:

- `axis_x`, `axis_y`
- `height`
- `lines_thickness`, `lines_opacity`
- `dots_thickness`, `dots_highlighed_thickness`, `dots_opacity`

For the exact schema, see `docs/plugins_reference.rst`.

## Behavior notes

- Axis scales use inferred column type behavior (numeric, categorical, etc.) from HiPlot parameter definitions.
- If either axis is unset or removed, the XY view is effectively disabled until both are available again.
- The panel reflects current filtered rows, so slicing in the parallel plot immediately updates XY.
