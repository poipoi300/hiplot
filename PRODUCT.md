# Product

<!-- impeccable:product-schema 1 -->

Written without an interview: the facts below are inferred from the
repository (README, AGENTS.md, `docs/`, the examples) and from the
maintainer's review rounds. Inferred facts are marked *(inferred)*.

## Platform

web

## Users

Machine-learning researchers and engineers who run hyperparameter sweeps and
experiment grids, from a few hundred to a hundred thousand runs. They open
HiPlot in a notebook, a Streamlit app, the `hiplot` web server or a
standalone HTML file, usually right after a sweep finishes, to find which
settings produced good runs and why the bad ones failed. *(inferred)*

## Product Purpose

HiPlot shows high-dimensional experiment results as interactive parallel
coordinates, scatter plots (one, two or three columns) and a table, all
driven by one selection. Brushing an axis narrows every view at once, so a
researcher can go from "ten thousand runs" to "these forty runs with a low
learning rate and AdamW" in a few gestures. Success is reaching a defensible
answer about a sweep without writing plotting code.

## Positioning

- One self-contained page: `experiment.to_html()` renders offline, makes no
  third-party requests and keeps working years later.
- Interactive at 50,000 rows and beyond: brushing, reordering and recoloring
  stay fluid (`docs/PERFORMANCE.md` holds the numbers).
- Honest pictures: density instead of overplotting, colorblind-safe
  palettes, a legend for what color means, statistics that state their
  method.

## Operating Context

- Embedded in Jupyter (light or dark JupyterLab themes), Streamlit, or a
  browser tab next to the training code; often on a laptop screen, sometimes
  a 4K monitor. *(inferred)*
- Long sessions of brushing and comparing; the page state, brushes
  included, lives in the URL so a view can be shared or reloaded.
- Data arrives as Python dicts, CSV, or experiment fetchers; columns are
  numeric, log-scale numeric, categorical, timestamps, with NaN and inf.

## Capabilities and Constraints

- Displays: parallel plot (WebGL2 density rendering, Canvas 2D fallback),
  scatter panels (distribution of one column, XY, 3D), the table.
- The Python API (`hip.Experiment`, `display`, `to_html`, `display_st`) and
  the experiment payload stay backward compatible; saved page state from
  older versions must keep loading.
- No network access at runtime; fonts and assets are bundled.
- Python 3.12+ via `uv`, frontend via Bun, React 19 class components, d3 v7.

## Brand Commitments

- Name "HiPlot", the existing HiPlot logo marks in `hiplot/static/`.
- Typeface: IBM Plex Sans, self-hosted.
- Light and dark themes, both first-class; the user's choice is remembered.

## Evidence on Hand

- `examples/hptuning/tune.py`: a real GPU hyperparameter search (10,000
  trials) rendered with HiPlot.
- The built-in demos served by `hiplot` (`demo`, `demo_big`, …).
- `bench/`: seeded synthetic experiments for the rendering benchmark.
- No testimonials, customer names or usage statistics exist; do not invent
  them.

## Product Principles

1. The selection is the product: every view answers "what did I brush?".
2. Fast enough to think with: no gesture may wait on rendering.
3. Say what a number means: units, notation and statistical method are
   explicit, never implied.
4. Calm by default: data carries the color; chrome stays quiet.

## Accessibility & Inclusion

- WCAG AA contrast for text in both themes, including axis labels drawn on
  canvases and SVG.
- Colorblind-safe default palettes (Okabe–Ito, viridis family).
- Every control reachable by keyboard with a visible focus ring; respects
  `prefers-reduced-motion`.
