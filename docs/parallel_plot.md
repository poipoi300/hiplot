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
  to resize it. Brushes that overlap or touch merge into one when you release.
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

The parallel plot uses:

- Canvas layers for fast polyline drawing
- SVG for axes, labels, and brushes

This allows large-row rendering without losing axis/interaction fidelity.

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
- Hidden/inverted/order state and the brushes are persisted via persistent state and restored on reload.
- Keep and Exclude save the brushes of an axis as one filter that replays the union of their ranges.
