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
highlighted rows. The rendering control selects:

- **Automatic**: use continuous density above 6,000 filtered rows on software or
  unidentified renderers, above 250,000 on identified hardware, or after exact
  frames measure slower than 20 frames per second. This decision happens before
  a large dataset's first draw, while retaining fast hardware's exact path on
  moderate datasets.
- **Continuous density**: count every row into retained adjacent-axis histograms,
  with `max(256, min(1024, ceil(axis height)))` endpoint bins per axis in CSS
  coordinates and a separate missing-endpoint bin. Sparse layers evaluate every
  occupied cell; dense layers integrate a continuous endpoint field. Curved
  density uses pair-local easing. Hover and highlights retain the original,
  unquantized row coordinates, and outer-axis strips use exact endpoints.
  Idle images render at device-pixel resolution. Gesture previews use CSS-pixel
  resolution and can reduce horizontal evaluation on software renderers, then
  refine on release. Every preview includes all rows and their color statistics.
- **Exact lines**: render every original row with WebGL density accumulation,
  or Canvas 2D where WebGL2 is unavailable. This can be very slow on large data.

Continuous density stays active after a gesture. Both rendering modes default
to **Curved**; **Straight** is a manual choice. Older saved automatic line shapes
load as curved. The rendering and line-shape choices are saved in the URL.
Older saved `"low"` quality settings select continuous density; `"full"` selects
exact lines.

Execution location is independent of rendering mode and row count. Both modes
start locally when their predicted working buffers fit within 256 MiB; larger
working sets go directly to a worker. Two completed local draws taking more than 50 ms promote
subsequent draws to a worker for the plot's remaining lifetime, including mode
changes. This confirmation avoids promotion for a single cold shader compile.
Local continuous rendering yields between axis pairs. Busy frames coalesce while
the SVG brush follows the pointer immediately. Workers remain embedded in
standalone HTML, with no network requests required.

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
