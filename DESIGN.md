---
name: HiPlot
description: Interactive parallel coordinates and linked plots for ML experiment sweeps
colors:
  light-bg: "#f8f8f6"
  light-fg: "#1f2328"
  light-muted: "#59616b"
  light-axis: "#8b929a"
  light-tick-text: "#2a2f35"
  light-rule: "#dcdcd8"
  light-surface: "#ffffff"
  light-accent: "#2459c9"
  light-context-line: "#8d949c"
  dark-bg: "#15181c"
  dark-fg: "#e4e7eb"
  dark-muted: "#a9b1bb"
  dark-axis: "#5e666f"
  dark-tick-text: "#d5dae0"
  dark-rule: "#2c3238"
  dark-surface: "#1e2227"
  dark-accent: "#6ea2ff"
  dark-context-line: "#6f7781"
  keep-dot: "#2e9e5b"
  exclude-dot: "#d1453b"
  light-brush-active: "#f2b900"
  light-brush-active-stroke: "#a86f00"
  dark-brush-active: "#ffcc33"
typography:
  title:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "26px"
  axis-title:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  tick:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  control: "6px"
  panel: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "20px"
components:
  control-button:
    backgroundColor: "transparent"
    textColor: "{colors.light-fg}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "28px"
  control-segment-pressed:
    textColor: "{colors.light-fg}"
    typography: "{typography.control}"
    height: "28px"
  icon-segment:
    size: "28px"
    rounded: "{rounded.control}"
  panel:
    backgroundColor: "{colors.light-bg}"
    rounded: "{rounded.panel}"
  popover:
    backgroundColor: "{colors.light-surface}"
    rounded: "{rounded.panel}"
    padding: "10px"
---

# Design System: HiPlot

## Overview

**Creative North Star: "The Lab Bench"**

HiPlot is an instrument, not a dashboard. The data carries the color; the
chrome is a quiet bench the data sits on: hairline rules, one neutral family,
one accent for "what you selected". Density is high and unapologetic, as in
an oscilloscope or a lab notebook, and every mark earns its place by
answering a question about the sweep.

Both themes are designed, not inverted: light is warm paper (`#f8f8f6`),
dark is a near-black slate (`#15181c`) for long evening sessions next to a
dark editor. Lines are tone-mapped densities, so ten thousand runs read as
structure instead of a solid block.

**Key Characteristics:**
- One sans (IBM Plex Sans) at a tight scale, tabular numerals everywhere.
- Color is reserved for data and for the selection accent.
- Flat surfaces; only floating layers (menus, popovers, tooltips) cast shadow.
- Every control in a toolbar is the same 28 px control, in one row.

## Colors

Neutral warm-gray chrome; a single blue accent; data palettes come from
`src/lib/colors.ts` (Okabe–Ito and Tableau 10 for categories, viridis family
and diverging maps for numbers), themed per background.

### Primary
- **Selection Blue** (light `#2459c9`, dark `#6ea2ff`): brushes, focus
  rings, pressed segments' tint (`--hip-brush-fill`), links. Never decoration.

### Neutral
- **Paper / Slate** (`--hip-bg`): page and plot background.
- **Ink** (`--hip-fg`): titles, values, control labels.
- **Pencil** (`--hip-muted`): secondary text (counts, hints, units). Must keep
  ≥ 4.5:1 against `--hip-bg` in both themes.
- **Axis Gray** (`--hip-axis`): axis lines, tick marks, grips.
- **Tick Ink** (`--hip-tick-text`): tick labels, drawn over a halo of the
  background so they read over dense lines.
- **Rule** (`--hip-rule`): hairline borders and dividers.
- **Context Line** (`--hip-context-line`): deselected rows behind the
  selection.

### Named Rules
**The Data Owns Color Rule.** Hue in the chrome is limited to the selection
accent, the Keep/Exclude dots, and the amber interaction highlight, which
appears only on the brush being hovered, moved or resized. Statistical overlays (fits, flow badges)
take a neutral or a hue chosen outside the active color map, never one of the
data's own colors.

## Typography

**Body Font:** IBM Plex Sans Variable (self-hosted; system-ui fallback).

**Character:** an engineering sans with open counters; tabular numerals keep
columns of values aligned.

### Hierarchy
- **Title** (600, 13px): section bars ("Scatter plots"), panel kinds.
- **Axis title** (600, 12px): parallel-plot and scatter axis names.
- **Body / control** (400–500, 13px): buttons, menus, table cells.
- **Tick** (400, 11px, tnum): tick labels and badges.

## Layout

- The top panel is one row: logo, data actions with the selection count, the
  color legend, the plot's controls, app actions and the theme switch at the
  far right. It never wraps; below its natural width it scrolls sideways.
- Plots fill the width with 20 px gutters; panels stack vertically, each
  resizable from its bottom edge.
- The parallel plot keeps axes at least their label width apart and scrolls
  virtually when they do not fit.

## Elevation & Depth

Flat by default: depth is tonal (rules and backgrounds). Only floating
layers cast a shadow: menus and popovers `0 8px 24px var(--hip-shadow)`,
tooltips `0 2px 8px rgba(0, 0, 0, 0.18)`.

## Shapes

Controls 6 px radius, panels and popovers 8 px, value tags and badges are
pills. Borders are 1 px hairlines in `--hip-rule`.

## Components

- **Control button** (`controls.button`): 28 px tall, transparent, 1 px rule
  border, 13 px/500 ink label; hover darkens the border to Axis Gray;
  disabled at 45 % opacity. Header actions, Columns, Reset brushes, the
  color-map picker and "Add …" all use it.
- **Segmented control** (`controls.segmented`): the same 28 px box divided
  by rules; the pressed segment takes the accent tint and 600 weight. The
  theme switch is its icon variant: 28 px square segments with 16 px
  stroked icons (sun, moon, monitor) and a tooltip naming each.
- **Popover**: surface background, 8 px radius, floating shadow, opens below
  its control and closes on Escape or an outside press.
- **Column picker** (`lib/columnpicker`): a popover with a 32 px filter
  box over a list of 32 px rows in 14 px ink, inset 6 px inside the panel,
  their text aligned with the filter's. A chosen row shows an accent
  checkmark at its right and a faint accent tint; neighboring chosen rows
  share one band. The row under the pointer or the arrow keys takes a
  neutral tint, with a 2 px accent ring when the keyboard put it there.
  Focus stays in the filter (a combobox over a listbox): the arrows and
  PageUp/PageDown move, Enter picks. The Columns menu chooses several,
  with Select all and Deselect all; a scatter axis chooses one column or
  None and closes. A scatter axis's button is the control button with the
  muted axis letter, the column and a chevron.
- **Lasso selection**: while a lasso's rows are the selection, a 24 px pill
  after the selection count, in the accent tint with a 45 % accent hairline:
  a dashed loop icon in the accent, "Lasso selection · N rows" in 12 px/500
  ink and an 18 px round clear button. The lasso being drawn is a dashed
  1.5 px accent outline over the accent tint, under a crosshair.
- **Toast**: bottom-right, surface background, floating shadow, ink text;
  errors carry a red dot like Exclude. Disappears after a few seconds or on
  dismiss.
- **Brush tags**: pills in the brush stroke color with background-colored
  600 text, at the top and bottom edges of each brush (one tag when a
  categorical brush covers a single category), in the notation of the
  axis's ticks. The brush under the pointer or in a gesture turns amber
  (`--hip-brush-active-*`: amber fill with ink text, an amber 1.5 px band
  stroke) and the other tags on its axis drop to 30 % opacity, so
  overlapping brushes keep their tags apart.
- **Flow badges**: right of each category next to a brushed axis, a pill in
  the background color at 82 % opacity with a hairline rule, a muted arrow
  pointing the way the selection flows and the count in 10.5 px/600 ink.
- **Fits**: 2 px lines (1.25 px for the 3D plane grid) in the fit color,
  chosen per color map and theme as the candidate hue furthest in Lab from
  every data color with ≥ 3:1 contrast on the background; reference
  curves (KDE) are dashed in Pencil. A caption states the method.

## Do's and Don'ts

- Do keep one control vocabulary: if a toolbar button looks different from
  its neighbor, one of them is wrong.
- Do state statistical methods next to their numbers (criterion, n).
- Don't put data colors on chrome, or chrome colors on data.
- Don't wrap the top panel into a second row.
- Don't use Bootstrap button skins; use the shared control classes.
