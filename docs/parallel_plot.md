# Parallel Plot

This page documents HiPlot's core Parallel Plot display, rendered by `src/parallel/parallel.tsx`.

## What it shows

Each datapoint is drawn as a polyline across column axes:

- One axis per visible parameter
- One line per filtered datapoint
- Color driven by the active color-by setting

This is the primary surface for slicing and filtering high-dimensional data.

## Core interactions

- **Brush axis ranges**: drag vertically on an empty part of an axis to filter by value
  interval. Dragging on another part of the same axis adds a second brush: an axis keeps
  the rows inside any of its brushes, and the axes combine, so a row is selected when it
  passes every brushed axis. On a categorical axis a brush selects the categories inside it.
- **Move and resize a brush**: drag inside a brush to move it, drag its top or bottom edge
  to resize it. Brushes that overlap or touch merge into one when you release. A brush
  covering a whole axis filters nothing, so it is removed on release, as are brushes
  that merge into the whole axis.
- **Remove brushes**: click or tap a brush without dragging to remove it. Click or tap
  anywhere else on the axis, outside its brushes, to remove all of that axis's brushes;
  "Clear brushes on this axis" in the axis menu (right-click or long-press) does the
  same, and **Reset brushes** removes every brush.
- **Range tags**: each brush shows its range in a tag above and below it. A tag moves just
  inside its brush when an axis end or a neighboring brush leaves no room outside.
- **Reorder axes**: drag axis headers left/right.
- **Invert axis**: toggle axis direction from the label/context menu.
- **Hide axis**: remove columns from the display.

All of these interactions feed into HiPlot's shared filtered/selected state, which updates the other displays (XY, Distribution, Table).

## Rendering model

SVG draws the axes, labels and brushes; canvas layers draw density and exact
highlighted rows. The **Exact lines / Binned density** control selects:

- **Automatic**: use binned density above 6,000 filtered rows on software or
  unidentified renderers, above 250,000 on identified hardware, or after exact
  frames measure slower than 20 frames per second. This decision happens before
  a large dataset's first draw, while retaining fast hardware's exact path on
  moderate datasets.
- **Binned density**: a dedicated worker counts every row into adjacent-axis
  histograms. Endpoint resolution defaults to `min(256, ceil(axis height))` bins
  per axis, measured in CSS pixels, with a separate bin for missing endpoints.
  Raster work has a separate budget: sparse pairs draw every occupied cell;
  above 4,096 drawable cells per pair, neighboring endpoint-space tiles are
  combined until at most 4,096 remain across selected and context layers.
  Every cell contributes its counts, endpoint sums, color statistics and numeric
  extrema; cells are aggregated, not periodically sampled or discarded.
  Each layer draws weighted straight segments through its tile's mean endpoints.
  Individual geometry is approximate: dense tiles can combine several fine
  endpoint bins, curves become straight segments and antialiasing differs.
  Hover and highlights still use the original, unquantized row coordinates.

  During brush or axis gestures over more than 20,000 rows, a separate worker
  draws a deterministic **128-row sampled preview at half CSS resolution**.
  Its geometry, colors and selection use the same sampled row identities.
  This temporary picture can miss rare selected features and is not
  density-equivalent to the all-row refinement. On release, the full worker
  counts every row and refines the binned picture; an obsolete preview cannot
  replace that refinement. Row-order invariance applies to the all-row raster,
  not to the source-row-stratified preview sample.
- **Exact lines**: render every original row with WebGL density accumulation,
  or Canvas 2D where WebGL2 is unavailable. This can be very slow on large data.

Binned density stays active after a gesture; it does not replace the picture
with a potentially minute-long exact draw on release. The line-shape controls
are disabled while it is active, and their previous choice is retained for
exact mode. The rendering choice is saved in the URL. Older saved `"low"`
quality settings now select binned density; `"full"` selects exact lines.

See `PERFORMANCE.md` for completed-frame measurements and visual tolerances.

## Display configuration

Display-level settings are provided through `exp.display_data(hip.Displays.PARALLEL_PLOT)`.

Common options:

- `order`: explicit column order
- `hide`: columns hidden by default
- `invert`: columns inverted by default
- `categoricalMaximumValues`: auto-hide threshold for very high-cardinality categorical axes

For the full schema, see `docs/plugins_reference.rst`.

## Behavior notes

- Columns with a single effective value can disappear unless you force a range in parameter definitions.
- High-cardinality categorical columns can be hidden automatically by `categoricalMaximumValues`.
- The rows' `uid` is a column like any other (numeric when the uids are numbers, such as a
  trial index), offered in the Columns menu and in the scatter axis pickers. It is not drawn
  as an axis unless `order` lists it or it is shown from the Columns menu.
- A lasso drawn in a scatter plot replaces the selection: it clears the brushes (see
  `docs/scatter_plot.md`).
- Hidden/inverted/order state and the brushes are persisted via persistent state and restored on reload.
- Keep and Exclude save the brushes of an axis as one filter that replays the union of their ranges.
