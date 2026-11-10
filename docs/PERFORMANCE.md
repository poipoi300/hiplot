# Rendering performance

This page records how fast HiPlot renders large experiments, so every change
to the rendering path is measured against the same numbers.

## Method

`bench/make_experiments.py` generates four seeded experiments and renders
each to a standalone HTML page:

| Size | Rows | Columns | Column mix |
|---|---|---|---|
| 5k × 20 | 5,000 | 20 | linear numeric, log-scale numeric (seven decades), categorical (3 to 12 values), sparse numeric with 2% inf and 3% NaN |
| 20k × 30 | 20,000 | 30 | same rotation |
| 50k × 50 | 50,000 | 50 | same rotation |
| 100k × 30 | 100,000 | 30 | same rotation (measured from the second round on, and part of the default run since the seventh) |

`bench/run.ts` opens each page in headless Chromium (full build, GPU enabled,
1600 × 1000 viewport) and measures, per page load:

| Metric | Definition |
|---|---|
| HTML MB | Size of the standalone page, bundle included. |
| decode ms | Time inside `JSON.parse` or `eval` calls on strings over 1 MB, i.e. decoding the embedded experiment. |
| DOM ready ms | `domContentLoadedEventEnd`: HTML parse plus the synchronous setup script. |
| initial drawn ms | Navigation start to the last line draw call of the first render. |
| full redraw ms | A color-by change to the last draw call of the redraw. |
| drag frame p50 / p95 / max | Frame intervals while a brush is dragged across 50% of an axis, one mouse move per animation frame for 120 frames. |
| stalls | Frames longer than 50 ms during that drag. |
| brush end → lines ms | Mouse-up to the last line draw call. |
| brush end → table ms | Mouse-up to the last mutation of the table. |
| JS heap MB | `usedJSHeapSize` after the run. |

Line draws are Canvas2D `stroke`/`fill` and WebGL `draw*` calls, counted by
instrumentation the harness installs before any page script runs, so every
version of HiPlot is measured the same way. "Last draw" means no further draw
call for 500 ms and 20 frames. Each cell is the median of three page loads.

Reproduce with `bash bench/run.sh` (builds the bundle, renders the pages into
`$HIPLOT_BENCH_DIR`, measures them), or step by step:

```bash
bun run build
uv run python bench/make_experiments.py --out <dir>
node bench/run.ts --dir <dir> --reps 3 --label <name>
```

`bench/run.ts` runs under Node because Bun cannot yet drive Playwright's
browser pipe on Windows.

Machine: Windows 11, NVIDIA GeForce RTX 5090 (ANGLE / Direct3D 11), Chromium
from Playwright 1.63, 120 Hz frame clock (8.3 ms frames).

## Baseline

Commit `83d7897` (fork state before the forge conversion).

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20 | 4.2 | 3 | 152 | 372 | 142 | 8 / 9 / 9 | 0/120 | 179 | 215 | 38 |
| 20k × 30 | 18.1 | 15 | 658 | 1443 | 663 | 8 / 17 / 17 | 0/120 | 631 | 185 | 262 |
| 50k × 50 | 69.4 | 64 | 2766 | 5946 | 2934 | 17 / 25 / 25 | 0/120 | 2730 | 273 | 542 |

Reading the baseline:

- Drag frames look smooth only because the progressive renderer draws at most
  300 lines per frame and restarts on every brush event. The cost shows up as
  latency instead: at 50k rows the lines finish drawing 2.7 s after the mouse
  is released, and a full redraw takes 2.9 s.
- Initial render time is dominated by line drawing (5.9 s at 50k), on top of
  2.8 s of HTML parsing for a 69 MB page whose payload is a JSON string inside
  a JavaScript string literal.
- The table updates within 300 ms of brush end at every size; DataTables with
  deferred rendering only builds the visible page.

## Rendering performance work, step by step

Each step was measured right after its commit with the same harness; cells
are medians of three page loads. Runs on a shared workstation drift by up to
about 15% between sessions, so read small differences as noise.

1. **Frame-budget renderer** (`ac5c0ab`): animation-frame drawing sized from
   the measured cost per line, instead of a d3.timer capped at 300 lines that
   kept ticking after finishing.
2. **Color bins** (`41783fe`): colors quantized and parsed once; one stroke
   per color bin per frame; rows shuffled once per dataset; `moveTo` after
   `beginPath`.
3. **Geometry cache** (`9009baa`): per-axis Float32Array of pixels and per-row
   color bins, recomputed only when a scale, its range, or the coloring
   changes.
4. **Columnar brushing** (`afbce42`): per-axis masks on typed arrays,
   recomputed only for the axis whose brush moved.
5. **Direct brush rendering** (`8f6387d`): no React round trip per brush move;
   the selection is published once per gesture and the table updates without
   its debounce.
6. **WebGL2 renderer** (`c7cfc50`): one instanced draw call; brushing uploads
   only the selection flags.
7. **Compact payload** (`2cd6243`): column-major strict JSON in a JSON script
   block, plus a leaner load path.

### 5k × 20

| Step | HTML MB | DOM ready ms | initial drawn ms | full redraw ms | drag p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms |
|---|---|---|---|---|---|---|---|---|
| Baseline | 4.2 | 152 | 372 | 142 | 8 / 9 / 9 | 0 | 179 | 215 |
| 1 frame budget | 4.2 | 144 | 326 | 34 | 8 / 117 / 125 | 31 | 0 | 52 |
| 2 color bins | 4.2 | 149 | 314 | 29 | 8 / 67 / 83 | 13 | 58 | 111 |
| 3 geometry cache | 4.2 | 144 | 342 | 15 | 8 / 67 / 83 | 10 | 49 | 211 |
| 4 columnar brushing | 4.2 | 157 | 353 | 18 | 8 / 67 / 83 | 11 | 0 | 137 |
| 5 direct rendering | 4.2 | 140 | 334 | 25 | 25 / 75 / 83 | 29 | 27 | 16 |
| 6 WebGL2 | 4.2 | 143 | 182 | 2 | 8 / 8 / 9 | 0 | 1 | 13 |
| 7 compact payload | 2.4 | 104 | 140 | 2 | 8 / 8 / 9 | 0 | 1 | 15 |

### 20k × 30

| Step | HTML MB | DOM ready ms | initial drawn ms | full redraw ms | drag p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms |
|---|---|---|---|---|---|---|---|---|
| Baseline | 18.1 | 658 | 1443 | 663 | 8 / 17 / 17 | 0 | 631 | 185 |
| 1 frame budget | 18.1 | 615 | 1477 | 642 | 9 / 108 / 158 | 18 | 665 | 221 |
| 2 color bins | 18.1 | 603 | 1386 | 557 | 8 / 125 / 258 | 20 | 523 | 187 |
| 3 geometry cache | 18.1 | 636 | 1488 | 555 | 8 / 225 / 408 | 21 | 561 | 171 |
| 4 columnar brushing | 18.1 | 612 | 1485 | 529 | 8 / 125 / 167 | 13 | 570 | 230 |
| 5 direct rendering | 18.1 | 595 | 1393 | 569 | 17 / 58 / 83 | 8 | 536 | 45 |
| 6 WebGL2 | 18.1 | 562 | 722 | 5 | 8 / 8 / 9 | 0 | 1 | 29 |
| 7 compact payload | 7.6 | 395 | 475 | 4 | 8 / 8 / 9 | 0 | 1 | 26 |

### 50k × 50

| Step | HTML MB | DOM ready ms | initial drawn ms | full redraw ms | drag p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms |
|---|---|---|---|---|---|---|---|---|
| Baseline | 69.4 | 2766 | 5946 | 2934 | 17 / 25 / 25 | 0 | 2730 | 273 |
| 1 frame budget | 69.4 | 2319 | 5591 | 2593 | 17 / 75 / 133 | 15 | 2461 | 282 |
| 2 color bins | 69.4 | 2371 | 5564 | 2445 | 17 / 467 / 733 | 32 | 2183 | 298 |
| 3 geometry cache | 69.4 | 2405 | 5938 | 2370 | 17 / 117 / 200 | 19 | 2289 | 320 |
| 4 columnar brushing | 69.4 | 2321 | 5585 | 2403 | 17 / 92 / 117 | 19 | 2303 | 311 |
| 5 direct rendering | 69.4 | 2366 | 5474 | 2501 | 25 / 83 / 142 | 20 | 2262 | 124 |
| 6 WebGL2 | 69.4 | 2483 | 3081 | 11 | 8 / 8 / 9 | 0 | 1 | 126 |
| 7 compact payload | 27.1 | 1422 | 1667 | 6 | 8 / 9 / 9 | 0 | 2 | 91 |

What the steps show:

- The Canvas 2D path is bound by rasterization on the GPU process, which runs
  after the script yields: CPU-side wins (steps 2 to 4 cut a 5k redraw from
  142 ms to 15 ms) barely move the 50k numbers, and drawing more per frame
  (steps 1 and 5) trades the baseline's slow-but-smooth progressive drawing
  for visible stalls. It stays as the fallback for browsers without WebGL2.
- WebGL2 removes that bottleneck: a full 50k × 50 redraw takes 6 to 11 ms,
  brush drag frames stay at 8 ms median with a p95 and max of 8 to 9 ms and no
  stall, and lines are complete within 2 ms of releasing the mouse.
- Publishing the selection once per gesture took the table from 273 ms to
  about 100 ms after brush end at 50k rows. DataTables, with deferred
  rendering, then rebuilds its row list in that time, so a virtualized grid
  would not buy a visible improvement and the table keeps its features.
- The compact payload shrinks the 50k page 2.6x; with the leaner load path the
  first complete picture arrives in 1.7 s instead of 5.9 s.

## Final: baseline against the finished branch

Measured at `7460779`, after the design work, which added a two-pass density
render (float accumulation targets, then a tone-mapped composite) and a
context layer of deselected lines. Medians of three page loads.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, baseline | 4.2 | 3 | 152 | 372 | 142 | 8 / 9 / 9 | 0/120 | 179 | 215 | 38 |
| 5k × 20, final | 2.5 | 2 | 98 | 147 | 2 | 8 / 8 / 9 | 0/120 | 1 | 15 | 32 |
| 20k × 30, baseline | 18.1 | 15 | 658 | 1443 | 663 | 8 / 17 / 17 | 0/120 | 631 | 185 | 262 |
| 20k × 30, final | 7.7 | 16 | 357 | 475 | 5 | 8 / 9 / 17 | 0/120 | 1 | 22 | 117 |
| 50k × 50, baseline | 69.4 | 64 | 2766 | 5946 | 2934 | 17 / 25 / 25 | 0/120 | 2730 | 273 | 542 |
| 50k × 50, final | 27.2 | 74 | 1429 | 1686 | 7 | 8 / 9 / 9 | 0/120 | 2 | 88 | 277 |

At 50k × 50 the page is 2.6x smaller, the first complete picture arrives 3.5x
sooner, a full redraw is about 400x faster, brush drag frames measure 8 ms
median, 9 ms p95 and 9 ms max (17 / 25 / 25 ms before), and the lines are
final 2 ms after the mouse is released instead of 2.7 s. The density pass
costs nothing measurable against step 7: the GPU time of both passes is well
inside one frame.

One number regressed: decoding the embedded 50k × 50 experiment takes 74 ms
instead of 64 ms. The compact payload is parsed by `JSON.parse` from a JSON
script block where the baseline evaluated a JavaScript string literal; the
page is 2.6x smaller and DOM ready comes 1.3 s sooner, so the 10 ms are
accepted, but they are a regression.

## Second round: redesign without regression

The second round anti-aliased the lines, made the curves monotone splines,
spaced the axes for their labels (scrolling sideways when they do not fit),
tagged the brush edges, and redesigned the table with per-column filters.
"Before" is `2209ab7`, the branch as the first round left it; "after" is
`9ada92b`. Same harness and machine, medians of three page loads, with the
100k × 30 experiment added because it is what people load.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, before | 2.5 | 3 | 109 | 161 | 2 | 8 / 8 / 9 | 0/120 | 1 | 14 | 32 |
| 5k × 20, after | 2.6 | 3 | 100 | 152 | 2 | 8 / 8 / 9 | 0/120 | 1 | 16 | 33 |
| 20k × 30, before | 7.7 | 16 | 358 | 451 | 4 | 8 / 9 / 9 | 0/120 | 1 | 28 | 116 |
| 20k × 30, after | 7.8 | 15 | 365 | 476 | 4 | 8 / 8 / 9 | 0/120 | 1 | 29 | 175 |
| 50k × 50, before | 27.2 | 71 | 1364 | 1662 | 6 | 8 / 8 / 9 | 0/120 | 1 | 79 | 599 |
| 50k × 50, after | 27.2 | 63 | 1374 | 1634 | 6 | 8 / 8 / 9 | 0/120 | 2 | 83 | 264 |
| 100k × 30, before | 32.7 | 94 | 1675 | 2108 | 11 | 8 / 8 / 17 | 0/120 | 2 | 108 | 1129 |
| 100k × 30, after | 32.7 | 67 | 1293 | 1531 | 10 | 8 / 8 / 9 | 0/120 | 2 | 75 | 352 |

The first build of the redesign did regress: at 100k × 30 drag frames were
17 / 25 / 33 ms and the first picture came 230 ms later. Tracing a drag
found where the time went, and each cause was fixed rather than traded:

- **Canvases and paint spanned every axis.** Once the axes scrolled, the
  canvases, the SVG and the browser's raster covered the whole scroll width
  (4,700 px at 50 columns). The plot now scrolls virtually: it stays at the
  frame's width and draws the axes in view, with an overlay scrollbar and
  horizontal wheel gestures setting the offset.
- **Anti-aliasing doubles the fragments.** Each segment is a strip as wide as
  the line plus the half pixel where coverage reaches zero (not a full
  pixel), and the deselected-density target is single-channel (R16F instead
  of RGBA16F). While a brush or an axis is dragged over more than 20,000 rows,
  lines are drawn as plain one-pixel lines, which the density tone mapping
  makes hard to tell apart at that density; the picture is anti-aliased again
  on release, within the 2 ms "brush end → lines".
- **Dozens of text inputs.** Each table column filter was an `<input>`, a
  scroll container to the compositor, and every frame of a drag re-layerized
  the page around them (5 ms per frame). Filters are buttons until used.
- **Layout and paint per frame.** Brush tags are measured on a canvas instead
  of forcing an SVG text layout, and the tags draw without a filter.
- **A second layout after load.** The axis spacing depends on the widest tick
  label, which is only known once the axes are drawn; the first layout now
  applies it at once instead of redrawing on a debounced resize 100 ms later.
- **The table.** Formatted numbers are rendered for display only (sorting
  and searching read the value without a function call per row), and the
  search results are only counted while searching.

Read the small differences as drift: decoding is unchanged code yet moved
from 94 to 67 ms at 100k × 30 between the two sessions, and the JS heap is
sampled once after the run, so it swings with garbage collection. The
numbers in the wrong direction (brush end → table 79 → 83 ms at 50k × 50,
initial drawn 451 → 476 ms at 20k × 30) are within that drift, but have not
been shown to be zero.

## Third round: aliasing, flow badges and statistics

The third round mitered the anti-aliased line strips (steep lines no longer
break into dots), added flow badges that count the selection per category
next to a brush on every drag frame, put the header on one row, and added
statistics to the scatter panels. "Before" is `83fa04d`, the branch as the
second round left it; "after" is `0897a23`. Same harness and machine,
measured in one session, medians of three page loads.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, before | 2.6 | 3 | 115 | 172 | 2 | 8 / 8 / 9 | 0/120 | 1 | 17 | 33 |
| 5k × 20, after | 2.6 | 4 | 122 | 200 | 2 | 8 / 9 / 9 | 0/120 | 1 | 16 | 42 |
| 20k × 30, before | 7.8 | 16 | 383 | 511 | 4 | 8 / 8 / 17 | 0/120 | 1 | 30 | 162 |
| 20k × 30, after | 7.8 | 19 | 415 | 532 | 4 | 8 / 8 / 17 | 0/120 | 1 | 37 | 95 |
| 50k × 50, before | 27.2 | 68 | 1546 | 1837 | 6 | 8 / 9 / 17 | 0/120 | 1 | 95 | 266 |
| 50k × 50, after | 27.3 | 79 | 1512 | 1803 | 9 | 8 / 9 / 17 | 0/120 | 2 | 95 | 331 |
| 100k × 30, before | 32.7 | 90 | 1910 | 2250 | 10 | 8 / 9 / 17 | 0/120 | 2 | 121 | 352 |
| 100k × 30, after | 32.8 | 107 | 1874 | 2197 | 10 | 8 / 9 / 17 | 0/120 | 2 | 123 | 349 |

Reading it:

- Brush drag frames, stalls and brush end → lines are unchanged at every
  size, flow badges included: they count the selection from per-row
  category indices cached per axis, a tight loop over a typed array.
- The full redraw is the one cost the line fix adds. A mitered vertex reads
  the chord on each side of its point, so a straight segment's vertex makes
  three texel fetches instead of two. In two runs before the last, the
  100k × 30 redraw measured 13 to 16 ms and the 50k × 50 one 8 to 9 ms
  (6 ms before); straight segments now fetch the neighbor's far end alone
  rather than rebuilding the neighbor segment, which the last run measures
  at 10 ms. It is a one-off on a color or layout change, not per frame.
- Initial drawn at 5k × 20 is 28 ms later, and brush end → table at
  20k × 30 7 ms later. Both are inside this machine's drift between runs
  (DOM ready moved 7 ms on code that does not change parsing); the header
  now mounts the legend and the plot's controls in one row, which is the
  only new work at load.

## Fourth round: anti-aliasing under the density tone map

The fourth round found why lines still looked aliased and fixed it in the
density pass, which changes what that pass writes. Coincident lines (every
segment between two integer or categorical values) were tone-mapped as one
density N × coverage, which saturates at a tiny coverage, so the
anti-aliased edge of each bundle became a two-pixel hard step. Coverage is
now applied after the tone map: the line pass also keeps each pixel's peak
coverage, with MAX blending on the alpha channels, and the composite scales
the tone-mapped density by it. The second target, single-channel (R16F)
since the second round, is RGBA16F again to hold the selected and
deselected coverage sums and the deselected peak.

"Before" is `0897a23`, the renderer as the third round left it; "after" is
`cd5102f`. Same harness and machine, measured in one session, medians of
three page loads.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, before | 2.6 | 3 | 102 | 158 | 2 | 8 / 9 / 9 | 0/120 | 1 | 18 | 42 |
| 5k × 20, after | 2.6 | 3 | 98 | 157 | 2 | 8 / 8 / 9 | 0/120 | 1 | 16 | 42 |
| 20k × 30, before | 7.8 | 16 | 408 | 543 | 5 | 8 / 8 / 9 | 0/120 | 1 | 35 | 96 |
| 20k × 30, after | 7.8 | 17 | 404 | 525 | 5 | 8 / 8 / 9 | 0/120 | 1 | 33 | 182 |
| 50k × 50, before | 27.3 | 74 | 1368 | 1640 | 8 | 8 / 8 / 9 | 0/120 | 2 | 94 | 287 |
| 50k × 50, after | 27.3 | 65 | 1347 | 1642 | 6 | 8 / 8 / 9 | 0/120 | 2 | 88 | 342 |
| 100k × 30, before | 32.8 | 87 | 1654 | 1956 | 11 | 8 / 8 / 9 | 0/120 | 2 | 111 | 345 |
| 100k × 30, after | 32.8 | 87 | 1631 | 1933 | 11 | 8 / 8 / 9 | 0/120 | 2 | 112 | 346 |

Reading it:

- Drag frames stay at 8 ms median and 9 ms max at every size, with no stall,
  and a full redraw costs the same: the wider second target and the MAX
  blend fit in the frame. Lines are still drawn as plain one-pixel lines
  while a brush or an axis is dragged over more than 20,000 rows, and the
  frame after release is anti-aliased again (checked on a 25k-row page by
  the draw mode of the last draw call).
- The JS heap at 20k × 30 (96 → 182 MB) is one sample after the run and
  swings with garbage collection, as in earlier rounds; nothing in this
  round allocates on the JavaScript side.

## Fifth round: several brushes per axis

Each axis now holds a list of brushes, drawn and dragged by HiPlot itself
instead of one d3-brush per axis, and its selection mask is the union of
its brushes' ranges. A drag frame redraws the bands and tags of the axis
under the pointer only and recomputes that axis's mask only; the other
axes keep theirs.

"Before" is `e670536`, the fourth round's state; "after" is the branch
with several brushes per axis. Same harness and machine, measured in one
session, medians of three page loads. The benchmark drags one new brush
on an unbrushed axis, as in earlier rounds.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, before | 2.6 | 3 | 95 | 153 | 2 | 8 / 9 / 9 | 0/120 | 1 | 17 | 42 |
| 5k × 20, after | 2.6 | 3 | 101 | 160 | 2 | 8 / 9 / 9 | 0/120 | 2 | 17 | 33 |
| 20k × 30, before | 7.8 | 15 | 364 | 475 | 3 | 8 / 8 / 9 | 0/120 | 1 | 30 | 95 |
| 20k × 30, after | 7.8 | 16 | 371 | 488 | 4 | 8 / 8 / 9 | 0/120 | 2 | 33 | 173 |
| 50k × 50, before | 27.3 | 68 | 1483 | 1848 | 7 | 8 / 8 / 9 | 0/120 | 2 | 88 | 320 |
| 50k × 50, after | 27.3 | 69 | 1387 | 1680 | 7 | 8 / 8 / 9 | 0/120 | 3 | 93 | 259 |
| 100k × 30, before | 32.8 | 83 | 1702 | 2055 | 12 | 8 / 9 / 17 | 0/120 | 2 | 114 | 349 |
| 100k × 30, after | 32.8 | 87 | 1691 | 2036 | 11 | 8 / 8 / 9 | 0/120 | 3 | 115 | 354 |

Reading it:

- Drag frames stay at 8 ms median and 9 ms max at every size, with no
  stall: the custom brushes cost no more per frame than d3-brush did. The
  17 ms max at 100k × 30 before is one late frame in one of three loads.
- Brush end → lines is 1 ms later at every size: on release every axis
  redraws its bands, tags and tick labels, where d3-brush redrew the one
  it moved.
- Load and redraw columns move by a few percent in both directions between
  sessions, as in earlier rounds; the JS heap is one sample after the run
  and swings with garbage collection.

## Sixth and seventh rounds: brush tags, saved values and brush fixes

The sixth round fixed the brush tags, highlighted the brush under the
pointer and saved brushes as the values they select. The seventh read
`NA`, `N/A`, `null` and `None` as missing values, kept brushes that
select nothing on reload, clipped scatter fits out of the special-values
band, centred brushes on the axis line, removed brushes covering a whole
axis, and made a click outside an axis's brushes clear them. 100k × 30 is
part of the default run from the seventh round on.

"Round 6" was measured at `9a256a1` without the 100k × 30 page; "round 7"
at `2c0402a`. Same harness and machine, medians of three page loads, in
two sessions.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, round 6 | 2.6 | 2 | 83 | 139 | 2 | 8 / 8 / 9 | 0/120 | 2 | 15 | 33 |
| 5k × 20, round 7 | 2.6 | 2 | 77 | 119 | 2 | 8 / 8 / 9 | 0/120 | 1 | 13 | 33 |
| 20k × 30, round 6 | 7.8 | 16 | 288 | 412 | 4 | 8 / 8 / 9 | 0/120 | 2 | 28 | 117 |
| 20k × 30, round 7 | 7.8 | 11 | 247 | 343 | 3 | 8 / 8 / 9 | 0/120 | 2 | 23 | 121 |
| 50k × 50, round 6 | 27.3 | 48 | 953 | 1248 | 6 | 8 / 8 / 9 | 0/120 | 3 | 65 | 258 |
| 50k × 50, round 7 | 27.3 | 47 | 945 | 1166 | 5 | 8 / 8 / 9 | 0/120 | 2 | 57 | 258 |
| 100k × 30, round 7 | 32.8 | 72 | 1209 | 1588 | 8 | 8 / 8 / 9 | 0/120 | 3 | 89 | 352 |

Reading it:

- Drag frames stay at 8 ms median and 9 ms max at every size, with no
  stall, and lines are final within 3 ms of release. None of the seventh
  round's changes runs per drag frame: the whole-axis check and the saved
  form of a brush are computed once, when a gesture ends.
- Load times are lower than in the fifth round at every size (100k × 30:
  1,209 / 1,588 ms DOM ready / initial drawn against 1,691 / 2,036 ms) on
  code that did not change the load path. Read it as drift between
  sessions, as in earlier rounds, not as a gain.

## Eighth round: crisp axis labels, lassos and the column picker

The eighth round put axes and tick labels on device pixels (each tick
label is measured, then shifted, once its axis is drawn), made lassos
replace the selection in every scatter, and redesigned the column picker.
Only the label snapping runs on the parallel plot's load path; nothing
runs per drag frame. Measured at the commit that batches the label
measurements, same harness and machine, medians of three page loads.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20 | 2.6 | 2 | 84 | 140 | 2 | 8 / 8 / 9 | 0/120 | 2 | 15 | 33 |
| 20k × 30 | 7.8 | 14 | 257 | 361 | 4 | 8 / 8 / 9 | 0/120 | 2 | 27 | 113 |
| 50k × 50 | 27.3 | 54 | 955 | 1194 | 6 | 8 / 8 / 9 | 0/120 | 3 | 60 | 302 |
| 100k × 30 | 32.8 | 69 | 1158 | 1484 | 9 | 8 / 8 / 17 | 0/120 | 3 | 86 | 350 |

Reading it:

- Measuring and shifting every tick label one text at a time forced a
  layout per label: 50k × 50 (about 500 labels) drew in 1,313 ms against
  1,166 ms in round 7. Measuring them all before moving any brings it to
  1,194 ms, within the drift between sessions.
- Drag frames stay at 8 ms median and p95 with no stall; the 17 ms max at
  100k × 30 is one late frame in one of three loads, as in round 5.

## Ninth round: line rendering quality

The ninth round fixed three artifacts of dense line bundles: beading
between categorical axes, banded fans, and muddy colors where numeric lines
overlap. All three traced to the density pass:

- **Beading.** The density targets were half floats, which hold 11
  significant bits. A bundle of thousands of identical segments (100,000
  rows between batch_size and width: about 5,000 per segment) sums
  thousands of coverages per pixel, and a half-float sum stops growing once
  its spacing exceeds twice the added coverage, at a point that depends on
  that coverage. The color sum and the coverage sum it is divided by stall
  at different points, so the color swung by up to 30 levels from pixel to
  pixel along the bundle, and past 1 at its edges (saturated cyan). Read
  back from the targets, a pixel of such a bundle held 2048 in every
  channel. The sums a color is divided by are now single floats.
- **Bands.** The hard bands in fans such as best_epoch → val_accuracy were
  the same stalls, along each arm of the fan. What remains in a smooth fan
  of 30,000 lines is 8-bit rounding: opacity holds each level for 4.6
  pixels on average. The composite adds half a level of interleaved
  gradient noise, which brings it to 2.0.
- **Muddy colors.** Overlapping lines averaged their RGB colors, which for
  distant values gives colors the color map does not have (viridis's ends
  average to a brown). A numeric color-by column now sums values and shows
  the color map at their mean, or the line with the lowest or highest value
  on top (a new choice in the color-map popover).

Coverage is now the exact area of a pixel inside the line instead of a
tent over its distance: across a column of pixels it sums to the line's
area, so a line's intensity no longer swings with its offset between pixel
centers (by up to 18% at 45 degrees before; under 0.25% in the targets
now, and under 2% once rounded to 8 bits).

Deduplicating identical segments into one weighted instance was measured
and not adopted: with exact sums it no longer changes the picture, it
would cut the 100,000-row page's 1.4 million segments by 32% only, and
aggregating them takes at least 200 ms in JavaScript, on every selection
change of a brush drag.

"Before" is `5f811ff`, the branch this round forked from; "after" is the
round's last commit. Same harness and machine, medians of three page
loads, in one session.

| Size | HTML MB | decode ms | DOM ready ms | initial drawn ms | full redraw ms | drag frame p50 / p95 / max ms | stalls | brush end → lines ms | brush end → table ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 5k × 20, before | 2.6 | 2 | 94 | 161 | 2 | 8 / 8 / 9 | 0/120 | 2 | 15 | 33 |
| 5k × 20, after | 2.6 | 3 | 94 | 156 | 2 | 8 / 8 / 9 | 0/120 | 2 | 16 | 33 |
| 20k × 30, before | 7.8 | 11 | 253 | 347 | 4 | 8 / 8 / 9 | 0/120 | 2 | 23 | 117 |
| 20k × 30, after | 7.8 | 16 | 344 | 472 | 4 | 8 / 8 / 9 | 0/120 | 3 | 34 | 172 |
| 50k × 50, before | 27.3 | 59 | 1173 | 1487 | 7 | 8 / 8 / 9 | 0/120 | 3 | 70 | 312 |
| 50k × 50, after | 27.3 | 68 | 1232 | 1556 | 7 | 8 / 8 / 9 | 0/120 | 3 | 87 | 259 |
| 100k × 30, before | 32.8 | 80 | 1384 | 1694 | 13 | 8 / 8 / 9 | 0/120 | 3 | 84 | 350 |
| 100k × 30, after | 32.8 | 79 | 1366 | 1668 | 9 | 8 / 8 / 9 | 0/120 | 2 | 96 | 350 |

The harness times the CPU side of a draw. The GPU time of one redraw,
waited for with a one-pixel read-back (median of 20, 1600 × 1000, all rows
selected):

| Size | draft frame (plain lines), before / after | final frame (anti-aliased), before / after |
|---|---|---|
| 20k × 30 | 2.9 / 8.0 ms | 2.9 / 7.9 ms |
| 100k × 30 | 7.8 / 8.1 ms | 12.8 / 35.8 ms |

Reading it:

- Drag frames stay at 8 ms median and 9 ms max at every size. A first
  version summed everything in single floats with one blend equation per
  target: the line pass is bound by blending into the targets, and at
  100,000 rows it took 30 ms per draft frame, so drags ran at 17 ms per
  frame. Single-float targets alone took 3.4 times as long as half floats,
  and per-target blend equations another 18%. Now every target shares one
  equation, and draft frames (a drag over more than 20,000 rows) sum in
  half floats, as close to the old cost as measured; they may bead dense
  bundles until the drag ends.
- Final frames sum the coverages a color is divided by in single floats:
  at 100,000 rows the GPU takes 36 ms instead of 13 for one, on a brush
  release, a recolor or a scroll. Drags over 20,000 rows or fewer draw
  final frames, which now take 8 ms on the GPU at 20,000 rows: inside the
  8.3 ms frame on this machine, with no margin on a slower GPU.
- Load columns move within the drift between sessions seen in earlier
  rounds; the JS heap is one sample after the run.

## Million-row, unchanged-picture investigation

The older benchmark above times **submission**, not GPU completion. The new
`bench/parallel.ts` isolates the parallel display and includes fence completion:

```bash
bun run build
bun build bench/parallel.ts --target=node --packages=external --outfile=./node_modules/.cache/parallel-bench.mjs
node node_modules/.cache/parallel-bench.mjs --reps 1 --steps 3 --out <software.json>
node node_modules/.cache/parallel-bench.mjs --backend hardware --reps 1 --steps 3 --out <hardware.json>
```

Defaults are 1,000,000 rows, 10 numeric columns, seed 20261109, eight gesture
steps and three repetitions. The second variant quantizes the same seeded
values to eight integers. Payload generation and draw-order shuffling use
independent seeded generators. The browser receives the column-major payload
through the public `hiplot.render` API; this is not an HTML download/JSON decode
benchmark. Only `PARALLEL_PLOT` is enabled, excluding table/scatter work. Dataset
generation is reported separately from load-to-first-completed-frame, which
includes inference, geometry, uploads and GPU completion. Node drives Playwright
because Bun's browser pipe does not work on Windows; Bun bundles the harness's
local TypeScript imports first. The harness is outside the production bundle.

The software run uses exactly the four SwiftShader flags in
`playwright.config.ts`; hardware requests the full Chromium build and records
its actual unmasked GL renderer (never infer hardware from requested flags).
Both use a 1,000 × 700 viewport and device pixel ratio 1. The scroll phase narrows
the viewport to 360 × 700 so even short integer tick labels overflow. Forced
full quality disables row sampling/resolution reduction, but brushing and axis
dragging retain the existing plain-line draft path above 20,000 rows. Release,
initial and standalone redraw frames are full-quality anti-aliased frames.

Per-step samples include brush callback CPU time, filtering, object selection
materialization, cached selection flags, per-column geometry/color lookup,
selection/geometry upload submission, renderer submission, and fence latency.
Nested stage times **must not be added** to their parent CPU times. Geometry
lookup is per column, not per frame. Upload times are CPU submission costs;
GPU execution is included in the fence. Fence latency is wall time from renderer
submission to observed completion, not a hardware timer query: it includes
scheduling and polling error. It is suitable for SwiftShader and consistent
before/after comparisons, not a claim to isolate GPU execution from the OS.
Axis drag uses the real d3 mouse handlers and crosses neighboring axes; small
moves that do not reorder currently move SVG axes without redrawing lines.
Scroll measurements include the existing 150 ms settle redraw, and all queued
brush/scroll/deferred draws and fences settle before the next step. Raw JSON
contains every sample, p50/p95 and counts; single-load runs are exploratory,
not statistically significant claims. Repeat with defaults before interpreting
small differences. The instrumentation's pixel-equivalence test requires
**zero differing 8-bit channels** between instrumented and plain redraws.

### Baseline at `973f570`

Measured 2026-11-09 on the workstation above, one load and three gesture
steps per variant/backend (exploratory p50s, milliseconds):

| Backend / rows / data | Load → first fence | Full fence | Brush CPU | Filter / materialize | Brush draft fence | Axis redraw fence | Scroll fence |
|---|---:|---:|---:|---:|---:|---:|---:|
| RTX 5090 / 1M / continuous | 8919 | 227.3 | 18.5 | 6.7 / 7.9 | 50.1 | 75.8 | 109.5 |
| RTX 5090 / 1M / integer | 2206 | 241.9 | 16.9 | 6.0 / 6.5 | 63.5 | 97.1 | 108.9 |
| SwiftShader / 1M / continuous | **Cannot draw** | — | — | — | — | — | — |
| SwiftShader / 1M / integer | **Cannot draw** | — | — | — | — | — | — |
| SwiftShader / 100k / continuous | 19171 | 9422.3 | 6.0 | 2.0 / 1.2 | 9399.5 | 9361.4 | 15321.8 |
| SwiftShader / 100k / integer | 19232 | 9286.3 | 4.8 | 1.6 / 1.0 | 9259.4 | 9339.1 | 16963.1 |

The million-row software baseline fails rather than merely rendering slowly:
`Too many columns for one WebGL texture (20)`. Ten columns need 10 × 489
texture rows; the allocator reserves twice that, 9,780, beyond SwiftShader's
8,192 limit even though the actual columns fit. The benchmark records both
failures, preserves the errors in JSON and exits nonzero. The initial harness
waited 240 s for that failed display; it now surfaces the display's error
boundary immediately. These failures are not timings of a completed picture.

The hardware probe reports NVIDIA RTX 5090 via ANGLE Direct3D11, not software.
CPU selection upload p50 is 0.5 / 0.8 ms (continuous / integer); renderer
submission 0.2 / 0.8 ms, much smaller than the fence. Order-crossing axis steps
recompute all ten pixel columns: per-column p50 26.4 / 26.6 ms, followed by
25.1 / 30.0 ms of geometry-upload submission. Existing scale objects are
replaced on order-only reorders, invalidating otherwise reusable columns.
There is one axis line redraw across the three input steps, not three: the
current handler only redraws on a neighbor crossing. Scroll has six draws
across three steps because each step also schedules the settle redraw.

### Columnar selection and retained axis columns

The plot already had cached Float32 pixel columns, Uint32 color bins/order and
numeric/category brush inputs. The remaining object work was reconstructing a
`Datapoint[]` on **every** brush move. WebGL now consumes the live Uint8 mask
identified by its source row array. Only gesture publication materializes the
object selection; Canvas fallback still materializes each live selection.
External selections and Keep/Restore invalidate the live mask. Other components
continue to receive the unchanged `Datapoint` API. Row lookup construction also
avoids allocating a million temporary `[row, index]` arrays.

Order-only axis changes retain existing scale objects and therefore their cached
pixel columns. Added axes and changed parameter definitions still create scales.
Spare texture slots are capped at the actual device capacity: ten million-row
columns reserve sixteen slots on SwiftShader, rather than rejecting the plot
because twenty spare slots would not fit. Truly oversized data still fails.

Same exploratory protocol as the baseline, after this increment:

| Backend / rows / data | Load → first fence | Full fence | Brush CPU | Filter / live materialize | Brush draft fence | Axis redraw fence | Scroll fence |
|---|---:|---:|---:|---:|---:|---:|---:|
| RTX 5090 / 1M / continuous | 8360 | 228.3 | 8.0 | 6.0 / no calls | 54.4 | 47.7 | 109.0 |
| RTX 5090 / 1M / integer | 2198 | 241.4 | 7.8 | 5.7 / no calls | 73.8 | 55.7 | 108.1 |
| SwiftShader / 1M / continuous | 208678 | 100798.4 | 8.2 | 5.7 / no calls | 102651.8 | 102766.6 | 170824.6 |
| SwiftShader / 1M / integer | 203403 | 100618.4 | 8.6 | 6.0 / no calls | 100786.8 | 100172.1 | 176781.4 |
| SwiftShader / 100k / continuous | 20956 | 10328.4 | 2.0 | 0.6 / no calls | 10464.0 | 10469.7 | 17150.1 |
| SwiftShader / 100k / integer | 20706 | 10174.3 | 2.0 | 0.7 / no calls | 10331.5 | 10278.2 | 17816.9 |

Live brush CPU falls from 18.5 → 8.0 ms and 16.9 → 7.8 ms. Release still
materializes once (12.9 / 8.4 ms in this run). Axis per-column geometry lookup
falls from 26.4 / 26.6 ms to below the 0.1 ms timer resolution; geometry-upload
submission falls from 25.1 / 30.0 ms to 0.1 / 0.0 ms. The unchanged draw pipeline
still dominates software rendering; full/scroll hardware fences are essentially
unchanged, while the integer draft fence is **higher** (63.5 → 73.8 ms), not a
claimed GPU improvement. These single-load samples do not resolve run-to-run
GPU variation. At 100k rows on SwiftShader, brush CPU falls from 6.0 / 4.8 ms
to 2.0 / 2.0 ms, but full fences are **slower**, 9.42 / 9.29 s → 10.33 / 10.17 s,
and scroll fences 15.32 / 16.96 s → 17.15 / 17.82 s. The renderer submits the
same work; these runs do not establish a software rasterization speedup. The
software baseline also overlapped a small browser test, so it is not a clean
isolation of small GPU differences. The allocation correction removes the known
million-row capacity error; it does not reduce rasterization work. Both million-row
SwiftShader variants now finish, but the first picture takes 203–209 seconds,
a full frame about 101 seconds, and a scrolled frame 171–177 seconds. This is
**not interactive million-row software rendering**. There is no pre-change
million-row software fence to compare against because the allocator rejected it.

`tests/columnar-equivalence.spec.ts` requires zero differing 8-bit channels for
live typed flags versus object-reconstructed flags, retained versus rebuilt
scales, and capped versus unrestricted texture capacity. It also verifies
original publication order, external lasso/Keep/Restore, and Canvas fallback.
No shader, attachment format, blend equation or segment order changes.

### Sorted row-index experiment

`bench/parallel_index.ts` compares the existing tight typed-array numeric scan
with a sorted row index, binary searches and symmetric-difference mask updates.
Every resulting mask is checked against the scan. Reproduce independently of
GPU work with:

```bash
bun build bench/parallel_index.ts --target=node --packages=external --outfile=./node_modules/.cache/parallel-index.mjs
node node_modules/.cache/parallel-index.mjs
```

One million rows, one axis, 120 small moving-range steps, one exploratory run:

| Data | Index construction | Scan/query p50 | Indexed update/query p50 | 120 scans total | Index construction + 120 updates |
|---|---:|---:|---:|---:|---:|
| Continuous | 234.94 ms | 2.252 ms | 0.0055 ms | 281.32 ms | 237.10 ms |
| Eight integers | 156.23 ms | 2.196 ms | 0.0007 ms | 309.46 ms | 157.71 ms |

Sorted updates are excellent **after** construction. Eager construction costs
156–235 ms **per axis** before the first query, rather than the scan's 2.2 ms;
its cost amortizes only after roughly 70–105 warm steps in this small-delta
experiment. Ten eagerly indexed axes add about 1.6–2.4 s even before their first
brush. A three-step gesture loses badly, and the current GPU targets cannot
consume reversible selected-row deltas (see below). Consequently the shipped
columnar increment retains the existing typed numeric/category scans rather
than claiming an always-on sorted-index win. This is a measured deferral of
that part of item 1, **not** a completed per-axis sorted index. An asynchronous,
amortized index remains a possible separate design; none is hidden in the
production path. Its benchmark prototype is retained for reproducibility.

### Incremental density subtraction: rejected

The premise that every density attachment is a reversible sum is false. The
actual numeric final pass uses RGBA32F selected sums, RGBA16F coverage sums and
an RGBA32F winning-key target, with RGB ADD but alpha **MAX**. Draft targets
are half floats; categorical final targets use single floats. MAX peaks and
winning keys have no subtractive inverse, even before considering rounding.

`tests/density-contract.spec.ts` checks the production formats/blend state and
executes the same ADD/MAX reduction in an actual one-pixel WebGL framebuffer:

- Add contributions with coverage 1 and 0.25, then remove the first. Subtraction
  gives `[0.25, 0, 0, 1]`; recomputing the remaining line gives
  `[0.25, 0, 0, 0.25]`. The retained peak changes tone-mapped opacity by
  **11.57/255**, not a float-precision tolerance.
- Repeating 4,096 unit contributions in RGBA16F produces 2,048, because further
  unit increments round away. Subtracting 4,095 then produces **−2,047**, not
  the remaining line's 1. Lost contributions cannot be recovered by subtraction.

The first failure needs only one departed row. Consequently there is no
positive changed-row threshold that makes the proposed general subtraction
safe, and periodic or end-of-gesture refreshes do not fix incorrect intermediate
pictures. Recomputing peaks/winning keys and replaying original rounded sums
would require different retained state and invalidate the claimed cheap delta
operation. The unchanged-picture fallback remains a full redraw on every
selection change. No subtractive path or drift/threshold tuning is shipped.

## Dense accumulation precision

`tests/density-saturation.spec.ts` exercises the actual renderer with 8,192
coincident lines and reads its framebuffer and final RGBA pixels. Before the
fix, numeric final and categorical draft coverage both read **2,048** rather
than 8,192. A draft categorical pixel intended as RGB (51,153,204) became
(64,255,255): saturation visibly changed the picture, not just internal counts.
The regression also checks tone-mapped opacity below saturation, so numeric
coverage cannot silently stall behind otherwise-correct color sums.

All additive targets now use RGBA32F, in draft frames as well as final frames.
The density renderer already requires `EXT_float_blend`; unsupported devices
retain direct alpha blending rather than an incorrect half-float density path.
Normalizing all contributions does **not** fix half-float summation: the spacing
relative to each contribution still overtakes small increments after about
2,048 additions. Single floats avoid that failure for the intended million-row
range (unit counts remain exact through 2^24); arbitrary unbounded densities
would also exceed single-float precision and need the binned Float64 reduction.
Keeping one ADD/MAX equation across targets avoids per-target blending state;
mean mode still disables writes to the unused on-top attachment.

## Bounded binned renderer: design before implementation

The accepted goal here is density fidelity and interaction rather than identical
per-row pixels. A worker will count **every row**, then rasterize weighted
straight segments from adjacent-axis histograms. The foreground receives one
RGBA8 image, avoiding SwiftShader's per-row fragments. Exact highlighted rows
remain on the independent overlay. Curves in the exact renderer become straight
segments in binned mode; missing-value stubs remain.

A 2026-11-10 Node CPU prototype on this workstation measured 1M continuous rows,
ten columns, nine histograms and a 1000 × 500 nearest-pixel raster:

| Axis bins | Quantize ms | Count ms | Raster ms | Occupied cells |
|---|---:|---:|---:|---:|
| 64 | 12.4 | 24.6 | 23.6 | 36,864 |
| 128 | 11.9 | 34.0 | 70.9 | 147,456 |
| 256 | 10.4 | 45.4 | 273.9 | 589,804 |
| 512 | 21.4 | 84.8 | 1014.0 | 2,173,633 |

These are prototype costs, not completed browser-frame measurements. They reject
pixel-height histograms as the default: continuous data fills their quadratic
cell space. Start at 64 bins (maximum endpoint displacement about four CSS pixels
at 500px height), retain counts and color statistics instead of sampling rows,
and measure the actual worker and image composite before claiming interaction.
Use Float64 CPU sums, selected/context counts, numeric mean/missing share or
categorical RGB sums and numeric extrema. Recompute selected histograms for a
new mask, including extrema, rather than attempting unsafe MAX subtraction.

### Implemented tradeoff

The full colored/antialiased CPU kernel costs more than the initial DDA prototype.
A Node/V8 run at 1M × 10 and 1000 × 500 measured 133.4 ms counting plus
96.0 ms raster initially; a cached scroll raster takes 84.7–86.4 ms with
less than 0.1 ms recount. At 64 bins, counting is 136.4 ms and the warmed
raster 245.1–249.6 ms. Therefore the shipped default is **32 bins**, with
64 as the internal upper bound, not pixel-height bins. Per-cell selected and
context endpoint means reduce bias, but any individual endpoint can move by
almost a **whole bin** (15.625 CSS pixels at 500px height), not just a half bin.

Rasterization uses area-conserving major-axis box coverage rather than the
exact path's strip integration and peak normalization. An angle/distance LUT
experiment took 117 ms versus 104 ms for exact 32-bin box filtering and was
removed. The chosen approximate coverage takes about 85 ms in the warmed
kernel measurement. Histograms keep Float64 counts/statistics without sampling;
curves, sub-bin geometry, joins and antialiasing differ. The RGBA8 image is
computed at CSS resolution and nearest-upscaled on high-DPI canvases. These
are explicitly accepted approximations, not unchanged-picture optimizations.
New-mask counting still scales with source rows; worker execution protects the
main thread but does not by itself establish ten completed frames per second.

Cache pairs by column identities and selection/color revisions, not axis order
or screen position: reordering builds new pairs only; scrolling rasterizes the
cached counts. Copy/transfer worker-owned columns once per geometry change;
never detach the live geometry used by exact highlights. Coalesce work to one
in-flight job and one latest pending frame, reject stale results and terminate
on unmount. An inline worker must keep standalone HTML offline and self-contained.

Automatic mode must engage above a row threshold **before the first draw** so
software machines do not wait 100 seconds for performance detection. The existing
persisted `low` quality becomes the binned override and `full` remains exact;
auto also uses the existing slow-frame verdict. This supersedes gesture-only
sampling/half-resolution, rather than layering a second approximation over it.
The benchmark must explicitly choose mode and await worker completion as well
as the GPU fence, since its current forced-full path cannot measure this work.

A universal 6,000-row auto threshold would regress the workstation's already-fast
50k exact path (7 ms in the recorded benchmark) into the roughly row-independent
85 ms CPU raster. Therefore auto uses 6,000 rows on software/unknown renderers,
250,000 on identified hardware, or the existing measured-slow verdict on either.
The hardware limit sits above the measured 100k final frame (~36 ms) and below
the 1M frame (~228 ms); it is a conservative size heuristic, not a claim that
all GPUs have that crossover. Backend classification reads the actual unmasked
renderer (SwiftShader, llvmpipe, softpipe or a basic/software renderer), not
requested browser flags. Missing diagnostic information takes the conservative
software threshold. Explicit exact/binned overrides always win. A follow-up
50k-row `--quality auto` run on the actual RTX 5090 retained exact mode for
both data variants: completed full frames 26.0/31.7 ms and live brush frames
12.1/14.7 ms (one load, three steps). Those corrected-precision measurements
are not the older 7 ms half-float frame.

Validation will include count conservation, brushed-vs-fresh histograms,
missing colors/values and extrema; browser tests for mode switching, exact
highlight geometry and moderate straight-picture agreement with a stated
spatial tolerance. Hardware 1M and software 100k/1M runs will compare completed
frames to the recorded baseline. A hardware 10M attempt probes the existing
object-model/loading limit as well as raster capacity; a loading failure alone
cannot establish which stage or resource is responsible.

### Completed browser measurements

Measured 2026-11-10, same seeded experiment, viewport and actual backends as
above. Corrected exact hardware runs use one load and three gesture steps;
100k/1M binned runs use **three loads and three steps**, with the median of the
per-load p50s shown. The 10M integer capacity follow-up uses one load and three
steps. These are exploratory workstation measurements, not laptop
frame-rate guarantees. The old software figures above are reused rather than
repeating the roughly 50-minute million-row exact run.

`--quality full` chooses exact lines; `--quality low` chooses binned density.
The harness now awaits the latest accepted worker image **and** its GPU fence.
"Completed" starts at renderer request/submission, not the earlier input handler;
brush CPU remains separate. Binned completion includes copying/queueing, worker
counting/rasterization, image upload and observed fence completion. Its GPU-only
fence is about 5–6 ms, which must **not** be presented as total frame latency.
Nested stage medians need not add up to the parent median.

| Backend / rows / data / mode | Load → first fence ms | Full completed ms | Brush CPU ms | Brush completed ms | Axis completed ms | Scroll completed ms |
|---|---:|---:|---:|---:|---:|---:|
| RTX 5090 / 1M / continuous / corrected exact | 8729.9 | 357.9 | 8.9 | 167.3 | 167.7 | 193.7 |
| RTX 5090 / 1M / integer / corrected exact | 2460.1 | 380.6 | 8.0 | 180.2 | 180.9 | 184.7 |
| RTX 5090 / 1M / continuous / binned | 8057.6 | 94.5 | 8.4 | 208.7 | 173.9 | 64.2 |
| RTX 5090 / 1M / integer / binned | 1801.1 | 30.5 | 7.6 | 100.5 | 59.8 | 19.1 |
| SwiftShader / 100k / continuous / binned | 718.0 | 79.9 | 1.6 | 121.7 | 120.5 | 62.2 |
| SwiftShader / 100k / integer / binned | 299.2 | 30.5 | 1.7 | 40.1 | 35.4 | 16.8 |
| SwiftShader / 1M / continuous / binned | 7457.6 | 86.7 | 7.1 | 201.6 | 148.3 | 63.2 |
| SwiftShader / 1M / integer / binned | 1683.1 | 29.3 | 7.5 | 97.4 | 55.2 | 16.8 |
| RTX 5090 / 10M / integer / binned | 18405.2 | 46.7 | 73.2 | 744.9 | 263.8 | 33.3 |

Reading the measurements honestly:

- Fixing half-float saturation costs bandwidth: exact hardware full frames rose
  from the prior 228.3/241.4 ms to 357.9/380.6 ms, and drafts from 54.4/73.8 ms
  to 167.3/180.2 ms. The earlier faster frames used incorrect half-float sums.
- Binned full hardware frames take 94.5/30.5 ms instead of the corrected exact
  357.9/380.6 ms. **Continuous hardware brushing regresses** from 167.3 to
  208.7 ms and axis completion from 167.7 to 173.9 ms; bounded CPU reduction is
  not always faster than this GPU. The user can force exact lines. Moderate
  hardware datasets retain exact mode automatically.
- Software full frames at 100k fall from the prior 10,328/10,174 ms to
  79.9/30.5 ms; at 1M, from 100,798/100,618 ms to 86.7/29.3 ms. New 1M brush
  completion is 201.6/97.4 ms rather than 102,652/100,787 ms, with 7.1/7.5 ms
  main-thread brush CPU. That is responsive input with roughly 5/10 Hz density
  updates for these gestures, **not** a claim of 60 Hz million-row pictures.
- At 1M, worker brush recount/raster medians are 88.0/123.3 ms on hardware
  continuous and 81.1/115.5 ms on software continuous; integer data is
  68.7/26.3 and 66.3/25.0 ms. The near-constant raster cost between 100k and
  1M is the intended bound; recount and the application's initial inference
  still scale with rows. Initial continuous software loading remains 7.46 s.

Reproduce, after building the benchmark as above:

```bash
node node_modules/.cache/parallel-bench.mjs --quality low --backend hardware --rows 1000000 --reps 3 --steps 3 --out <hardware-binned.json>
node node_modules/.cache/parallel-bench.mjs --quality low --rows 100000 --reps 3 --steps 3 --out <software-100k-binned.json>
node node_modules/.cache/parallel-bench.mjs --quality low --rows 1000000 --reps 3 --steps 3 --out <software-1m-binned.json>
```

### Capacity and continuous-input checks

The initial hardware **10M-row continuous-data attempt did not complete
loading**. After more than 17 minutes without a first frame or a returned load
result, it was stopped. The initial benchmark `page.evaluate` (payload
generation/render setup) has no deadline, unlike its subsequent 240-second
frame wait, exposing a harness limitation. There was no captured out-of-memory
diagnosis; a memory limit or renderer-capacity failure cannot be inferred.

A separate **10M-row integer follow-up succeeded**, using the same exported
benchmark loader and gesture measurement with a 180-second whole-attempt
deadline and stage/crash diagnostics. Ten axes with eight values each generated
in 1.27 s and reached their first completed image in 18.41 s after generation.
Full cached rendering took 46.7 ms, brush completion 744.9 ms, new-axis-pair
completion 263.8 ms and scrolling 33.3 ms (one load, three steps). Brush CPU
was 73.2 ms; worker recount/raster were 709.0/28.6 ms. This establishes 10M
integer-row capacity, **not fluid 10M brushing or continuous-data capacity**.
The bounded raster remains cheap while row-dependent loading and recounting
now dominate. Both the unsuccessful continuous attempt and the successful
integer result are retained rather than generalizing from either one.

Settled-step benchmarks do not test continuous input. A separate real-brush
regression delays actual worker submissions by 80 ms while moving the brush
every animation frame for at least 1.5 seconds and five worker jobs (with a
10-second safety deadline under full-suite contention). All job-count, input
and accepted-image assertions remain required. Initially, a 1.5-second run with
90 movements and ten worker jobs produced **zero images before release**: latest-only result rejection
starved presentation. During a gesture, the main driver now waits for the
active worker/GPU frame to finish before requesting the latest state, using
the existing idle-redraw queue. The issued image can therefore present without
an unbounded request backlog. The regression now requires at least two
accepted images while the gesture is still active and passes; finite bursts
outside gestures still retain latest-only result rejection.

### Picture and interaction contract

`tests/binned.spec.ts` compares a seeded 300-row, four-axis straight dataset.
It premultiplies RGBA before comparing, blurs vertically by one full endpoint
bin (15 CSS pixels at 465px height), and excludes ten-pixel axis joins. The
limits are relative L1 error **≤20%**, absolute channel MAE **≤4/255**, and
integrated-alpha ratio **0.9–1.1**. The measured errors are **8.2943%**,
**2.48715/255**, and **0.91884**, respectively. Nonblank mass assertions keep
empty pictures from passing. This is a spatial density tolerance, not a claim
that individual pixels or rows retain their geometry.

The hover test matches actual path commands to original double-precision row
scales exactly and independently redraws the reference on the same canvas,
requiring **zero different channels**. Separate canvas surfaces can differ by
one antialiasing level, so that would not be an exact geometry test. Other browser
tests cover latest-only worker coalescing, preserved source buffers, offline
worker startup, mode switching/persistence, and Canvas-only image presentation
with zero live object-selection materializations and one on publication. The
existing exact-renderer pixel-equivalence tests remain unchanged in purpose.

## Pixel-scale endpoints and progressive brushing

The measurements below supersede the 32-bin implementation at `a2b1d9d`.
The preceding sections remain its historical baseline, not the current default.
The later **Population-preserving raster aggregation** section supersedes the
mass-resampled raster described in this section; endpoint counting and sampled
previews retain the resolution and sampling contracts below.

### Resolution is not the raster budget

Merely increasing the old kernel's bins reproduced its quadratic cost. A Node
V8 probe at 1M continuous rows, ten axes, 1000 × 500 pixels measured:

| Bins | First count ms | First raster ms | Brushed count ms | Brushed raster ms |
|---|---:|---:|---:|---:|
| 32 | 140.8 | 87.4 | 107.3 | 132.8 |
| 64 | 116.3 | 244.6 | 108.3 | 387.1 |
| 128 | 125.8 | 840.0 | 142.3 | 1352.4 |
| 256 | 171.2 | 3478.8 | 209.8 | 6086.5 |
| 500 (512 requested) | 250.7 | 12634.5 | 262.0 | 17241.9 |

The revised kernel separates **endpoint resolution** from **raster work**.
Endpoints use `min(256, ceil(axis height))` CSS-pixel bins by default, with
16-bit indices and an internal maximum of 512. At the 465px benchmark height,
a bin is 1.82px rather than 14.53px; endpoint means can still move by up to a
whole bin. CSS resolution intentionally bounds cost independently of DPR;
exact highlights retain the original device-resolution path.

Every row contributes to the final histogram. For a selected/context layer
with more than 4,096 occupied drawable cells per pair, deterministic systematic
mass resampling chooses at most 4,096 weighted representatives from those
**fine-resolution cells**, without snapping their endpoints back to a coarse
grid. It conserves layer count mass, not individual cell geometry or per-pixel
color/extrema. Sparse layers, including the integer benchmark's bundles and the
300-row visual fixture, render every occupied cell. Both-missing cells count
toward the row statistics but cannot consume the drawable-cell budget.
Iteration visits occupied cells, not every empty entry in the fine grid.

This is a deliberate additional approximation. Counts are all-row Float64
reductions; the raster is no longer a rendering of every occupied fine cell.
Rare geometric/color features can be omitted by the representative budget.
The exact override and independent exact highlight remain available.

A hardware browser comparison (one seeded load per dataset, all selected,
straight exact reference, 1000 × 700 viewport) measured the following. Raster
cost is a warmed worker-equivalent CPU kernel, **not** complete input latency.
The error is premultiplied RGBA relative L1 after a fixed two-pixel vertical
blur, excluding ten-pixel axis joins; the spatial tolerance does not grow with
the chosen bin count.

| Requested bins | Actual bins | 300-row raster ms | 300-row error | 1M continuous raster ms | 1M continuous error | 1M integer raster ms / error |
|---|---:|---:|---:|---:|---:|---:|
| 32 | 32 | 28.2 | 12.96% | 77.7 | 12.60% | 20.5 / 6.30% |
| 64 | 64 | 27.2 | 6.93% | 245.7 | 4.04% | 21.1 / 6.30% |
| 128 | 128 | 28.3 | 5.83% | 244.4 | 4.57% | 19.3 / 6.30% |
| 256 | 256 | 26.7 | 5.69% | 267.0 | 5.07% | 20.0 / 6.30% |
| 512 | 465 | 27.4 | 5.69% | 311.7 | 5.40% | 19.2 / 6.30% |

The 256-bin default removes needless coarse geometry on sparse pictures and
has essentially the same moderate-data error as pixel-height bins. Going to
465 bins costs about 44% more first counting (158.2 → 228.0ms), 17% more cached
raster, and about 3.3× histogram storage for ten axes (roughly 64 → 210MB,
excluding pixel columns and image buffers), without improving this dense
budgeted picture. The 64-bin dense picture actually has lower aggregate error
than 256 because its 4,096 cells do not require mass resampling: finer endpoints
and a fixed raster budget are not a monotone density-fidelity improvement.
The chosen compromise favors fine geometry without unbounded rasterization;
it is not a claim that every metric improves with resolution.

Against the unblurred 1M continuous picture, relative error falls from
13.42% at 32 bins to 5.96% at 256; channel MAE falls from 15.40 to 6.84/255,
and integrated alpha from 0.8747 to 0.9557 of exact. The sparse 300-row
unblurred error falls from 24.68% to 5.97%, MAE from 7.91 to 1.92/255.
The integer picture is unchanged by the bin increase: its distinct endpoints
already fit in 32 bins, and its approximately 6.3% error is from the existing
approximate antialiasing, not histogram resolution.

Exact and 32/64/128/256/512-bin screenshots for 300 continuous, 1M continuous
and 1M integer rows are saved in
`C:/Users/Administrator/AppData/Local/Temp/hb/gpt-run3/` as
`exact-<rows>-<variant>.png` and `binned-<bins>-<rows>-<variant>.png`.
The corresponding raw timings/errors are in `visual-comparison.json` there.
These are local review artifacts, not repository assets. Visual inspection
shows the old coarse lattice and large holes in the dense 32-bin picture;
the fine bounded raster removes that lattice, but retains representative-line
texture rather than the exact picture's perfectly smooth dense gradients.

### Preview first, all-row refinement after the gesture

The prior 208.7ms hardware brush completion was not image upload: its median
worker recount/raster were 88.0/123.3ms, while the final GPU fence was only
about 5–6ms. The direct kernel probe reproduced about 95ms recount/122ms raster
at 32 bins. Increasing endpoint resolution alone makes this worse.

During gestures above the existing 20,000-row draft threshold, a separate
worker renders a stable **128-row stratified preview at half CSS resolution**.
The sample is deterministic, spans source-row strata, and does not use a
periodic stride that can alias a column's period. Geometry and colors share
the same sampled row identities; selection is re-read for those identities.
Counts/color sums and the tone-map reference carry the source/sample weight;
coverage peaks do not. Preview endpoints have approximately two-CSS-pixel
resolution even though the temporary image is half size.

On release the full worker recounts every row at the fine resolution and
refines the picture. A subsequent gesture can immediately use the preview
worker even if that refinement is still running; obsolete full images cannot
overwrite an active preview, nor obsolete previews the final full image.
Each channel retains one active and one latest pending job; active input is
paced to allow issued previews to present. Small non-preview gestures retain
the same pacing, preventing the previously discovered starvation bug.

This buys interaction latency, **not cheaper final refinement**. Sparse preview
selection can miss a rare selected feature until refinement; the menu tooltip
explicitly identifies sampled previews. Preview and full images must not be
reported as equivalent work or as unchanged per-row pictures.

The visual regression now uses a **fixed two-CSS-pixel** blur, relative error
**≤6.5%**, channel MAE **≤2.2/255**, and integrated-alpha ratio **0.93–0.97**.
These replace the historical one-bin blur, 20%, 4/255 and 0.9–1.1 limits;
nonblank energy checks and exact highlighted-row geometry remain required.
Separate browser regressions require a sampled image while an all-row job is
still running, all-row refinement afterward, continuous-input presentation,
coalesced busy moves and cancellation on release. Half-resolution stubs are
scaled with the image so they remain 15 CSS pixels rather than doubling in
width. Sampled columns, colors and masks must identify the same source rows;
malformed source lengths fail rather than silently changing identities.
The final browser fixture measured **5.3026%** relative error, **1.58845/255**
MAE and **0.947254** alpha ratio. These are the actual regression attachment
values, distinct from the separate resolution-comparison probe above.

Actual 1M-row gesture screenshots are also saved as
`gesture-preview-<variant>.png`, `gesture-refined-<variant>.png` and
`gesture-exact-<variant>.png`, with metadata in `preview-inspection.json`.
They have been visually inspected: the temporary 128-row picture is visibly
sparse and is **not density-equivalent** to the refinement. It shows the brush's
geometric effect quickly; the tight visual tolerance applies to the all-row
refinement, not that temporary preview.

### Completed input-path measurements

The benchmark now separately timestamps brush-method entry, brush callback
entry, renderer request, worker stages and the observed GPU fence. Its
`inputToVisible` is **brush-method entry → completed GPU frame**, including
selection and scheduling, not compositor/photon timing. `completedFrame` keeps
its historical renderer-request origin; the two must not be confused.

That distinction exposed a second bottleneck. With 512 preview rows, renderer
request → completion was 45.4ms hardware / 43.5ms software, but input → completion
was **83.4 / 65.2ms**. A hardware scheduling probe measured 31.2ms waiting for
the brush RAF before the 8.1ms callback. An idle large binned preview now starts
immediately; busy moves still coalesce and use the existing paced redraw.
Exact mode and small gestures retain their original RAF path. The new browser
regression first failed with zero immediate requests, then passed with one,
while retaining busy-move coalescing and release cancellation.

Removing that queue alone gave 68.1 / 51.1ms continuous input latency: the
512-row worker still cost about 35ms, and hardware fence observation added
18–29ms on these frames. Reducing the sample to 256 rows lowered software input
latency to 44.2ms but left hardware at 68.4ms; its roughly 29ms worker still
missed the earlier presentation opportunity. At 128 rows, continuous worker
cost fell to 17.5 / 18.6ms and typical hardware completion reached the earlier
frame. This chooses a measured temporary preview budget, not a lower final
histogram resolution. Full images and their tightened visual limits are
unchanged by preview sample size.

Final 1M × 10 measurements on the actual RTX 5090 and SwiftShader, three loads
and three settled gesture steps per dataset/backend, milliseconds. Entries are
medians of per-load p50s; the last column is the median of per-load p95s. With
only three steps, that p95 is essentially each load's slowest step, not a
well-estimated population tail.

| Backend / data | Load → image | Full completed | Brush CPU | Worker count / raster | Request → fence | Input → fence | Input p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| RTX 5090 / continuous | 6892.3 | 273.9 | 7.1 | 6.0 / 12.8 | 32.5 | **39.3** | 68.1 |
| RTX 5090 / integer | 1701.7 | 50.4 | 8.0 | 3.6 / 9.0 | 27.0 | **37.1** | 38.2 |
| SwiftShader / continuous | 6792.6 | 267.8 | 7.3 | 5.6 / 13.3 | 30.6 | **38.0** | 47.0 |
| SwiftShader / integer | 1656.5 | 28.4 | 8.1 | 3.3 / 8.9 | 21.5 | **29.4** | 40.3 |

The approximately 50ms goal is met for typical moves in these samples, **not a
hard bound**: the first hardware continuous preview took 62.9–68.6ms, while
subsequent steps took 35.9–39.6ms. Preview sampling can miss rare selections;
all-row refinement remains necessary. Input → request is now about 7–8ms,
with less than 0.1ms brush queue wait. Nested medians must not be added.

| Backend / data | Axis completed | Release all-row refinement | Scroll completed |
|---|---:|---:|---:|
| RTX 5090 / continuous | 37.2 | 647.3 | 305.4 |
| RTX 5090 / integer | 34.9 | 145.3 | 37.7 |
| SwiftShader / continuous | 26.5 | 648.6 | 280.8 |
| SwiftShader / integer | 14.4 | 145.3 | 17.5 |

Axis, release and scroll entries retain the renderer-request → fence origin,
not an input-event origin. Fine continuous full/scroll frames are **slower** than
the historical 32-bin 94.5 / 86.7ms full frames; release refinement takes about
0.65s. This is the
explicit fidelity cost, not an across-the-board speedup. Exact mode is unchanged.
Raw final data are `preview128-hardware-1m.json` and
`preview128-software-1m.json`; intermediate `input-*`, `queue-*`, `idle-*` and
`preview256-*` files retain the measurement trail in the artifact directory.

### Bounded 10M continuous failure

A fresh, isolated capacity probe imposed a 150s whole-attempt deadline and
recorded browser-side stage/heap observations externally. Generation finished
in 1.76s; the payload held about 1,061MB of JS heap. Row materialization reached
about 3,367MB; `makeDatasets` finished at 6.41s with about 3,536MB observed.
Inference then copied a 10M-entry distinct Set and mapped a 10M-entry numeric
array. At 10.65s the numeric mapping had returned (about 3,443MB observed);
the first numeric sort had **not started** when the attempt was forcibly
terminated at 150.20s. No 10M geometry, histogram, texture upload or image had
been reached. The process tree was gone and the blocked evaluation rejected
by 150.36s. Raw stage evidence is `capacity-diagnostic.json` in the local
artifact directory.

This localizes the hang to loading/inference after multi-gigabyte allocations,
not worker counting or a WebGL texture-size failure. Allocation/GC pressure is
consistent with the observations, but there is **no captured OOM exception or
proven universal browser capacity limit**. Continuous column expansion stores
100M non-integer row properties; inference additionally retains
all distinct values and creates mapped/filtered/deduplicated numeric copies.
Eight-integer data has the same row/property count but only eight distinct
numeric values per column and different VM number storage costs. Reworking the
public object model or dropping distinct values would be a separate design,
not a safe incidental renderer optimization.

The benchmark now has a default **180s whole-attempt deadline**, configurable
with `--timeout-ms`, covering the initial evaluation as well as all frame and
gesture waits. On expiry it kills its own Playwright `BrowserServer` process,
reports dataset/row count and last stage, flushes structured JSON, exits nonzero
and stops remaining attempts. It awaits owned-process shutdown before returning
control to the caller, writes results before context cleanup and does not try
to close a disconnected context. A forced 1ms CLI smoke caught the earlier race:
context cleanup threw while the browser was still being killed, skipping the
JSON file. The stricter regression first failed with the page still open at
helper return; it now requires the page already closed, retaining the unchanged
<5s cleanup limit. The CLI smoke now records its stage/deadline error, exits 1,
and stops the remaining attempts in about 258ms. Merely racing a promise leaves
the renderer running; graceful context closure was also measured taking about
six seconds on a deliberately CPU-bound evaluation. The regression retains its <5s cleanup
limit and uses the owned server's force-kill instead. This is an explicit,
bounded unsupported-capacity result, **not a claim that 10M continuous data now
loads in the application**. The prior successful 10M integer result remains
valid, and neither result generalizes to every dataset.

## Weighted segment merging after the float correction

Re-tested the rejected idea against the corrected RGBA32F exact renderer on
2026-11-10. Automatic million-row pictures are already binned; this probe uses
**100k rows × ten axes on the RTX 5090**, within the hardware exact-mode size
range, rather than claiming a benefit for a path auto mode no longer uses.
It is one exploratory comparison per dataset, not a cross-device guarantee.

The scratch prototype groups segments with the same pair, color bin and
selection, quantizing coordinates to 1/8px. Its key also includes the four
neighboring endpoint coordinates needed to preserve straight-line AA joins;
merging only a segment's two endpoints does not preserve those joins. A weighted
representative retains the first member's actual coordinates. Weights multiply
only additive color/count components, not MAX coverage or the winning key.
The original 1.1M segments include the leading/trailing missing-value stubs.

The stated visual acceptance criterion is **maximum final premultiplied RGBA8
channel difference ≤1/255** against the original exact picture. Both images
are checked nonblank and free of GL errors. Frame completion uses a one-pixel
readback barrier; an earlier `gl.finish()` probe returned zero timings and is
not used as timing evidence.

| Data | Merged groups | Segment reduction | CPU grouping ms | Upload submission ms | Exact completed ms | Merged completed ms |
|---|---:|---:|---:|---:|---:|---:|
| Continuous | 1,099,634 | 0.0333% | 814.0 | 2.3 | 36.4 | 36.4 |
| Eight integers | 196,487 | 82.1375% | 458.9 | 0.1 | 38.6 | 8.9 |

| Data | Differing channels / 1,755,840 | Maximum difference | Mean absolute difference, 8-bit levels | All-channel p50 / p95 / p99 |
|---|---:|---:|---:|---:|
| Continuous | 122 | 1 | 0.00006948 | 0 / 0 / 0 |
| Eight integers | 69 | 1 | 0.00003930 | 0 / 0 / 0 |

Every nonzero channel difference is exactly one level; there are no differences
of two or more. Thus these pictures pass the stated visual criterion after the
float correction, unlike the prior saturated half-float experiment. That does
**not** establish universal pixel equivalence.

**Do not ship merging.** It fails the net-cost criterion: the integer case
spends about 459ms regrouping to save 29.7ms drawing, and continuous data spends
814ms without a frame-time win. Selection is part of the grouping key, so this
cost matters on brush changes. Many unchanged redraws could amortize a retained
index, but that is not a measured interactive win here. Large automatic plots
already count coincident contributions through the binned renderer. No grouping,
weighted-instance shader or experimental texture code is committed. Reproduction
and raw distributions remain local in `merge-compare.mjs` and
`merge-comparison.json` in the run3 artifact directory.

## Design notes: WebGPU is an optional counting backend

The maintainer's decision is to consider WebGPU **later, as an addition, not a
replacement for WebGL2**. It is usable from the existing TypeScript; adopting it
does not require rewriting the UI or the experiment API.

The platform planning baseline is shipped WebGPU in Chrome/Edge on Windows,
macOS, ChromeOS and Android, Firefox on Windows, and Safari 26. Chrome on Linux
has lagged behind those platforms. Browser support alone is not an available
adapter: with no usable GPU, Chrome normally exposes **no WebGPU adapter**;
software fallback requires flags. Headless CI also needs explicit flags and
adapter checks. Do not assume that enabling the API supplies usable hardware,
or that a software WebGPU backend will beat the existing CPU histogram worker.
WebGL2 remains the baseline rendering path, with the current CPU worker and
Canvas fallback retained. A missing/failed WebGPU adapter must not make an
otherwise usable plot fail.

The interesting capabilities are compute shaders and atomic integer counts:
counting is exact within the chosen integer range, without the additive-float
saturation that motivated the precision fix. A compute backend could build
adjacent-axis selected/context histograms on the GPU instead of scanning every
row on the CPU. Integer counts alone do **not** make floating color sums,
coverage, tone mapping or final pixels exact; those contracts still require
independent equivalence/fidelity tests and overflow bounds.

Keep counting separated from rasterization and presentation. The existing
counting interface is `buildPairHistogram(...) -> BinnedHistogram`, with typed
selected/context counts, endpoint sums, color statistics and extrema.
`BinnedKernel` owns column/revision and adjacent-pair caching;
`rasterizeHistograms` consumes `BinnedPair` histograms independently of their
counting implementation. Preserve that typed boundary rather than coupling
counting to the WebGL compositor or embedding backend-specific state in the
rasterizer. The current implementation is a CPU function/worker, **not an
already-implemented pluggable WebGPU backend**.

If profiling shows counting limits GPU-equipped machines, add a compute counter
behind that boundary, with explicit source-column, selection and color revisions
and asynchronous request identities. Stale results must not combine old counts
with new axes or selections. Compare completed interaction/refinement latency,
including dispatch, uploads/readback and cache invalidation, not just compute
kernel duration. Keep the CPU implementation as both fallback and reference;
require the same row conservation, missing-value/color/extrema semantics and
visual gates. No WebGPU dependency, adapter requirement or implementation is
introduced by this decision.

## Verification of the pixel-scale follow-up

The final local-main stack gate passed after the deadline ownership fix:

```bash
DIFF_COVER_COMPARE_BRANCH=main bash tools/stack_coverage_gate.sh
```

Results: **118 Python tests, 424 Bun tests, 176 Playwright tests, and 93%
changed-line coverage** (6,119 changed executable lines, 380 missing). The
existing ≥90% gate and all visual, continuous-input and cleanup limits remain
in force. Normal commit-stage hygiene, Ruff, mypy, Biome with
`--error-on-warnings`, and strict TypeScript checks passed.

After coverage, all four plain bundle variants were rebuilt with `bun run
build`; 14 focused browser tests then passed against the restored plain bundle.
Correctness reviews were source-only, not a full-branch diff sign-off. The
scaled-stub finding was fixed with a RED/GREEN regression; follow-up reviews
found no additional concrete defects. The focused security review found no
high-confidence HIGH/MEDIUM vulnerabilities. A real CLI deadline smoke also
verified structured failure output and stopped attempts after owned shutdown.

No experimental merging or WebGPU code is shipped. The 10M continuous
application-loading limitation, first-preview hardware tail, visibly sampled
preview and slower fine-resolution refinement remain explicit above; test
success does not remove those measured limitations.

## Population-preserving raster aggregation

The fixed-offset mass resampler above was incorrect, not just approximate.
With 8,192 distinct occupied cells, alternating 4,096 red upper-region rows
and 4,096 blue lower-region rows gave red **zero** raster weight and blue
8,192. Grouping the same rows restored both populations. Layer mass conservation
alone did not detect this: first-occurrence cell order aliased the periodic
resampling tickets. The focused unit regressions failed before the fix with
zero upper-region alpha and a row-permutation channel difference of 255.

The raster now **aggregates every occupied cell** rather than selecting cells
and reallocating their mass. Fine counting still uses up to 256 height-limited
endpoint bins. Pairs above 4,096 occupied drawable cells merge neighboring
endpoint-space tiles until at most 4,096 remain, across selected and context
layers together. Counts, selected/context endpoint sums, color sums, missing
color shares and numeric extrema all reduce into their own tile. Missing
endpoints remain distinct; both-missing counts survive but consume no drawable
tile. Canonical endpoint order removes first-occurrence ordering from both
raster accumulation and tile reduction. The prepared raster histograms use the
existing pair/revision cache, so scrolling does not repeat the reduction.

This retains all populations' count and color contributions, **not their
individual geometry**. Each layer draws its own count-weighted endpoint means.
The dense continuous benchmark reduces 256 fine bins to 64 raster bins: a tile
spans four fine endpoint bins, about 7.3 CSS pixels at 465px height. An endpoint
can move by almost a whole tile, and colors/geometric features within one tile
can mix. Sparse pairs retain every fine cell without further coarsening; rare
features outside the populated endpoint region retain their own contributions.
The 128-row gesture preview is unchanged and can still miss rare selected rows
until all-row refinement. Exact lines and exact highlighted rows are unchanged.

### Measured choice and completed latency

Measured 2026-11-10 with the same seeded 1M × 10 public-API benchmark,
1000 × 700 viewport, verified RTX 5090 / ANGLE D3D11 and SwiftShader renderers.
Before/after use **three loads and three gesture steps**, summarized as medians
of per-load p50s. The every-cell alternative uses one load and three steps per
backend/data variant; its figures are exploratory, but the multi-second cost
rejects it as an interactive full-frame replacement. All figures are milliseconds.

| Backend / continuous data | Before full | Draw every fine cell | Aggregate full | Before / aggregate brush input → fence | Before / aggregate release refinement |
|---|---:|---:|---:|---:|---:|
| RTX 5090 | 271.7 | 3253.0 | 225.5 | 38.7 / 39.0 | 643.1 / 582.7 |
| SwiftShader | 267.6 | 3172.5 | 234.5 | 38.8 / 37.3 | 639.4 / 585.7 |

Drawing every cell also increased continuous release refinement to
5047.7 / 5060.2ms on hardware/software. It preserves fine geometry but costs
about 12 times the old cached full frame. Aggregation avoids dropping cells
without that cost. Cached raster CPU changed from 264.6 / 259.7ms to
218.6 / 226.4ms; all-row release count/reduction is 232.8 / 233.7ms.
The latter includes preparing the spatial aggregate, not just row counting.

| Backend / integer data | Before / aggregate full | Before / aggregate brush input → fence | Before / aggregate release refinement |
|---|---:|---:|---:|
| RTX 5090 | 33.9 / 51.3 | 37.1 / 36.6 | 140.3 / 130.0 |
| SwiftShader | 29.1 / 27.6 | 30.0 / 32.1 | 147.5 / 134.0 |

The hardware integer full-frame median is **higher**, not a claimed speedup:
its worker raster is essentially unchanged (21.3 → 21.0ms), while observed
GPU-fence latency moves from 10.5 to 29.1ms. These three-load wall-clock samples
do not establish the cause of that scheduling variation. Software integer
brush input also increases by 2.1ms. Continuous input p95 after aggregation is
67.5ms hardware / 46.5ms software; the earlier first-preview tail is not fixed.
Full/release figures start at renderer request, while brush input starts at
brush-method entry. Nested worker/fence medians must not be added.

Reproduce using the existing benchmark commands with `--quality low`,
`--rows 1000000 --reps 3 --steps 3`, once with `--backend hardware` and once
with the default SwiftShader backend. Raw before/after and every-cell results
are local artifacts in `C:/Users/Administrator/AppData/Local/Temp/hb/gpt-fix/`
(`before-{hardware,software}.json`, `after-{hardware,software}.json` and
`all-cells-{hardware,software}.json`), not repository assets.

Unit tests check every aggregate statistic, numeric and categorical colors,
missing endpoints, both-missing mass, both selected/context population visibility,
a separated single-row population and grouped/shuffled picture stability.
The browser worker regression independently requires both separated populations
and at most one differing RGBA8 level after row permutations. The unchanged
sparse-picture fidelity and exact-highlight tests still pass. The brief related
binned-path audit found no additional concrete order-dependent/data-loss defect;
that audit is source inspection, not a claim that previews are permutation invariant.

## Continuous histogram-space density: feasibility first

The maintainer rejected the bounded segment picture and the visibly sparse
128-row gesture preview. The approved replacement inverts rasterization: a
fragment queries the adjacent-axis count grid rather than drawing representative
segments. This section records the prototype **before production integration**;
the historical binned measurements above do not measure this design.

`bench/continuous.ts` uses the actual million-row benchmark page to obtain its
geometry: 944 × 465 CSS pixels, ten axes and nine 85–86px gaps at a 1000 × 700
viewport. It then evaluates a dense RGBA32F histogram (selected count, context
count, numeric color-key sum, missing-color count) in a separate WebGL2 context.
For each pixel it loops over one endpoint, solves the other endpoint, and uses
linear filtering along that coordinate. It switches loop direction at the pair
midpoint so the divisor is always at least 0.5. Straight interpolation uses
`w=t`; the pair-local eased curve uses `w=t*t*(3-2*t)`. The local slope supplies
the line-width/Jacobian correction. The production curve is necessarily an
approximation to neighbor-dependent monotone splines: a two-axis histogram
cannot recover the neighboring endpoints those splines require.

Measured 2026-11-10, one isolated browser per backend, two warm-ups followed by
five samples. Actual GL diagnostics identified RTX 5090 / ANGLE D3D11 and
SwiftShader / Vulkan. Completion uses a one-pixel **readback from the destination
framebuffer**, including the final linear upscale, not CPU draw submission.
Each pair has its own tightly sized framebuffer and is upscaled separately;
interpolation never reads the neighboring pair. Full plot means all nine pairs
(769 evaluated columns); one pair is 85 columns.
The probe histogram is synthetic and dense, not a timed million-row recount.
It exercises mean numeric color and density evaluation, not extrema, peak-AA,
missing stubs, worker transport or brush filtering. Those costs remain to be
measured in the complete implementation. Hardware sub-millisecond results are
near the browser timer's 0.1ms granularity and are not precise GPU timer queries.

| Backend / bins | One pair straight / eased ms | Nine pairs straight / eased ms | Quarter columns straight / eased ms | 1/16 columns straight / eased ms |
|---|---:|---:|---:|---:|
| RTX 5090 / 256 | 0.2 / 0.2 | 0.8 / 0.8 | 0.7 / 0.7 | 0.7 / 0.7 |
| RTX 5090 / 465 | 0.2 / 0.3 | 1.2 / 1.2 | 1.2 / 1.2 | 1.2 / 1.2 |
| RTX 5090 / 512 | 0.3 / 0.2 | 1.3 / 1.3 | 1.2 / 1.3 | 1.3 / 1.2 |
| SwiftShader / 256 | 8.7 / 12.3 | 104.0 / 112.0 | 20.4 / 21.1 | 6.6 / 6.9 |
| SwiftShader / 465 | 22.4 / 21.8 | 178.9 / 185.4 | 38.2 / 42.0 | 11.1 / 11.6 |
| SwiftShader / 512 | 17.2 / 22.5 | 195.4 / 200.2 | 39.6 / 41.1 | 12.1 / 12.5 |

The column fallback is justified on software: quarter-width evaluation can
approach interactive updates without dropping rows; 1/16-width provides further
headroom, but only six columns per pair and therefore a fidelity cost. Full-width
pixel-height bins are suitable for idle refinement, not a 60Hz software gesture.
These numbers pass the brief's feasibility checkpoint; they are **not** complete
input-latency or picture-equivalence results.

### Retained-state design

- Replace the old cell-budget raster and sampled preview, rather than layering
  another approximation over them. Keep the persisted `auto | low | full`
  contract and automatic hardware/software thresholds; name `low` continuous
  density in the quality menu.
- Count every row in separate selected/context integer grids with at least 256
  endpoint bins. Evaluate pixel-height bins against 256 in the complete picture
  and benchmark, including their quadratic storage cost. Missing coordinates
  have a separate bin and render the existing finite-endpoint stubs. Categorical
  and inverted axes are counted from their actual rendered pixel coordinates.
- Keep color-bin ranks and palette-channel sums as exact integers, with explicit
  bounds; subtraction must equal a fresh reduction, not merely look similar.
  Numeric lowest/highest require retained per-cell color membership or rescanning
  affected cell members when an extremum leaves. A minimum or maximum alone has
  no subtractive inverse. Missing colors do not win numeric extrema.
- Build per-axis sorted row indices in a worker from brush source values, not
  Float32 render coordinates: only source values reproduce inclusive brush and
  special-value semantics. Update the grid only for actual selection changes.
- Cache each pair image by grid revision and local geometry/style. Horizontal
  scrolling composites the cached images and must not re-evaluate pixels.
  Geometry changes, resize and changed grids invalidate the relevant pairs.
- Keep the independent highlighted-row overlay on original row geometry. No
  histogram bin or reduced-column image is an acceptable hover approximation.
- Preserve the existing logarithmic density reference and selected-over-context
  tone map. Endpoint reconstruction, pair-local curves and column interpolation
  are approximations and need measured, stated picture tolerances.

Reproduce after a plain build (Node drives Playwright on Windows):

```bash
bun build bench/parallel.ts --target=node --packages=external --outfile=./node_modules/.cache/parallel-bench.mjs
bun build bench/continuous.ts --target=node --packages=external --outfile=./node_modules/.cache/continuous-probe.mjs
node node_modules/.cache/continuous-probe.mjs --backend software --reps 5 --out <software.json>
node node_modules/.cache/continuous-probe.mjs --backend hardware --reps 5 --out <hardware.json>
```

Raw prototype samples are `prototype-software.json` and
`prototype-hardware.json` in
`C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/`.

### Same-session replacement baseline

Before changing the production bundle, the existing binned renderer was rerun
at 1M × 10, three loads and three steps per data/backend combination. The table
shows medians of per-load p50s in milliseconds. The raw before files are in the
same artifact directory. These brush images still use the rejected 128-row
preview: their latency must not be presented as a timing of all-row density.

| Backend / data | Load → image | Full completed | Brush CPU | Brush input → fence | Release refinement | Scroll completed |
|---|---:|---:|---:|---:|---:|---:|
| RTX 5090 / continuous | 7478.9 | 239.9 | 6.9 | 38.3 | 644.4 | 251.3 |
| RTX 5090 / integer | 1715.9 | 27.9 | 8.0 | 37.6 | 131.5 | 18.7 |
| SwiftShader / continuous | 7469.4 | 249.4 | 7.6 | 41.5 | 636.0 | 251.0 |
| SwiftShader / integer | 1674.1 | 28.0 | 8.2 | 38.4 | 133.5 | 19.7 |

### Current implementation and numerical contract

The bounded renderer, its representative-segment raster and both sampled-preview
channels are removed. The preceding binned sections are historical evidence, not
current behavior. `low` now means **Continuous density**; `full` remains exact
lines. Automatic selection retains the 6,000 software/unknown and 250,000
identified-hardware row thresholds and measured-slow-frame override.

`ContinuousKernel` uses `clamp(ceil(axis height), 256, 1024)` endpoint bins:
465 in the benchmark, rather than the old 256. Endpoints are rounded to the
nearest reconstructed coordinate `bin * height / (bins - 1)`, with a distinct
missing bin. Each pair has Uint32 selected/context counts, integer-valued
Float64 color sums, Uint32 numeric extrema, and original-row cell membership.
Counts support at most `2^32 - 1` rows. Categorical channels use
`round(channel / 255 * 65535)`; their sums remain below `2^48`. Numeric ranks
remain raw integers and require `rows * (colorMapBins - 1) <= 2^53 - 1`.
The worker retains these exact integers across additions/removals; Float32
texture uploads and RGBA8 presentation are rounded views, never the state used
for subsequent subtraction. Missing-color mass is separate from valid ranks
and cannot win highest/lowest. Removing a cell extremum rescans that cell's
retained members, rather than pretending MIN/MAX has a subtractive inverse.

Only actual changed rows alter pair statistics. Reusable typed touched-cell
scratch replaces transient per-cell objects/Maps, retaining about 8.5 MiB at
465 bins, shared by all pairs. Cancelling exchanges and no-op masks preserve
image revisions. Inactive source-column IDs are evicted before resize work;
restoring a hidden column reuploads it through the driver's active-ID protocol.
The grids and row-membership lists are not constant-memory with respect to row
count: at 465 bins, eleven pairs' histogram fields alone occupy about 100 MB,
plus roughly 98 MB for million-row membership lists/heads and 60 MB for ten
retained pixel/quantized columns. These are calculated buffer sizes, not measured
whole-browser heap usage.

Numeric brushes lazily build sorted original-row indices from Float64 source
values in an inline worker, not from quantized or Float32 drawing coordinates.
Categorical indices preserve the existing conversion/identity semantics.
Inclusive ranges, unions, undefined cells and optional nonfinite inclusion retain
the exact scan's semantics. While construction is pending, the exact scan remains
authoritative. Warm moves visit interval symmetric differences and update
intersection failure counts. `select` returns live flags; historical callers
must copy them. Exact WebGL now caches a snapshot of uploaded values, not buffer
identity, so successive moves of the same live buffer cannot leave stale GPU
selection. The density channel also snapshots queued flags. Mask copying,
comparison, selected-count calculation and worker transfer still have O(rows)
parts; a microsecond index update is not microsecond end-to-end brushing.

The worker's WebGL2 fragment integrates the reconstructed dense histogram by
solving the opposite endpoint and choosing the conditioned direction. It keeps
the exact path's normalized square/strip footprint, peak-aware logarithmic tone
map and selected-over-context composition. Per-cell sums supply numeric mean,
missing-color share or categorical RGB; actual integer extrema supply numeric
highest/lowest. Categorical palettes need no lookup texture, so cardinality is
not incorrectly limited to one GPU texture row. Both-missing rows count but do
not draw; finite endpoints retain 15px horizontal stubs.

For at most 512 occupied cells, a fragment instead queries every geometrically
intersecting occupied strip. A conservative 16-row CSR pixel-tile index skips
only disjoint footprints, including curved tangents and missing stubs. There is
no occupied-cell budget or row sampling. Independent CPU-reference and tile-edge
regressions require every positive footprint to remain queryable. Dense stubs
visit only bins inside the pixel's horizontal-strip support. Analytical center
coverage and an equivalent trapezoid CDF remove repeated branch work without
changing that coverage model.

Curved density uses pair-local `smoothstep(t)` and its derivative, **not** the
original neighbor-dependent spline. The original highlighted row still follows
its original unquantized spline/straight geometry. Each pair image is cached by
histogram identity/revision, local gap/height, curve/line width, color mode,
palette and density/context style. A fixed 1/65536px local-gap representation
prevents cancellation noise on fractional translations from invalidating the
cache. Interpolation is premultiplied and clamped inside each pair. Horizontal
scroll only composites retained images, including initially offscreen pairs.

A single all-row worker retains one active job and one latest pending frame.
Gesture pacing allows issued images to present; finite bursts still discard
obsolete results. Software dense gestures evaluate **1/16 of the columns**
(six in an 85px gap) and interpolate, refining full width on release. Sparse
pairs and hardware retain full columns. This applies below the exact renderer's
20k draft-row threshold too: pixel-integration cost follows occupied bins, not
source rows. All rows and endpoint bins remain unchanged during the gesture.
An unavailable OffscreenCanvas WebGL2 context uses the CPU reference; its
interactive performance is not established. A Canvas presentation surface does
not itself imply CPU evaluation: an inline worker can still have WebGL2.

### Fidelity and regression evidence

The seeded 300-row straight-picture regression retains the fixed two-CSS-pixel
vertical blur, relative L1 limit 6.5%, MAE limit 2.2/255 and nonblank checks.
It achieved **5.80590%**, **1.73922/255**, and integrated-alpha ratio
**0.999747**. Relative error is slightly higher than the previous 5.3026%;
aggregate alpha is much closer to exact than the previous 0.947254. The old
0.93–0.97 alpha interval enforced an underweight bias and rejected a perfect
match. The current test instead requires `abs(alphaRatio - 1) <= 0.04`, a
smaller maximum distance from correct mass than the old interval's 7%.
This is a spatial-density tolerance, not identical per-row pixels.

Six actual worker GPU/CPU cases cover sparse/dense, straight/eased, numeric
mean/highest/lowest, missing coordinates/colors and categorical RGB including a
20,000-entry palette. Five cases have zero differing channels; dense RGB's
maximum premultiplied difference is 0.671/255 and mean difference 0.000219/255,
within the unchanged 2/255 maximum and 0.25/255 mean limits. Exact hover tests
require identical original path commands and straight-highlight pixels. Other
regressions cover all-row gestures, row permutations, cache-only fractional
translation, mode switching, offline indices/workers, source-buffer ownership,
latest-only coalescing, Canvas presentation and sustained-input progress.

Review regressions reproduced stale exact flags (1,120,528 differing channels
on a second live move), oversized categorical-palette failure and obsolete
column retention before their fixes. All 33 focused browser tests then passed
without skips or retries, together with strict TypeScript/build and the parallel
unit suite. A focused static security review found no high-confidence HIGH or
MEDIUM issue; it was not runtime exploit testing.

### Final production measurements: 1M × 10

Same viewport, seeded data, row count and actual GL backends as the baseline;
three fresh loads × three settled brush steps per combination. Values are
**medians of per-load p50s**, milliseconds, not pooled percentiles. No browser
suite or other GPU benchmark ran concurrently. Data construction is outside
load → image. The continuous/integer datasets retain the original scale and
inverted-axis mix; integer data has eight values per axis.

| Backend / data | Load → image | Unchanged cached redraw | Full-width style recompute | Brush CPU | Brush input → fence | Release refinement | Scroll completed |
|---|---:|---:|---:|---:|---:|---:|---:|
| RTX 5090 / continuous | 7347.2 | 11.7 | 72.3 | 9.1 | 145.8 | 25.6 | 11.7 |
| RTX 5090 / integer | 1814.3 | 11.4 | 49.4 | 3.3 | 69.2 | 15.4 | 11.4 |
| SwiftShader / continuous | 9219.5 | 11.8 | 2117.0 | 8.2 | 272.1 | 1534.7 | 7.4 |
| SwiftShader / integer | 1883.5 | 11.4 | 56.4 | 3.2 | 80.9 | 14.4 | 7.2 |

The old unchanged "full" redraw performed raster work; the new one does not.
The new **recompute** phase clicks the opposite shape, waits for the worker
image and completed GPU frame, restores the actual original choice (including
Auto), then waits again. It records two genuine full-width evaluations. With
two samples the benchmark's upper median is the slower one, not a pure
straight-only measurement. Brush/release/axis/scroll still use the restored
original shape. Release is request → completed fence, as in the baseline;
materialization and brush CPU are separately timed and not included in that
column. Hardware/sparse release can reuse the previous pair images; software
dense release changes column resolution and must evaluate again.

| Backend / data | Brush filtering | Changed histogram | Worker raster/composite | Input → fence p95 | Axis completed |
|---|---:|---:|---:|---:|---:|
| RTX 5090 / continuous | 7.5 | 84.0 | 40.1 | 494.5 | 74.7 |
| RTX 5090 / integer | 1.7 | 25.8 | 34.2 | 255.9 | 58.1 |
| SwiftShader / continuous | 6.8 | 86.6 | 175.4 | 672.3 | 225.5 |
| SwiftShader / integer | 1.7 | 26.0 | 48.2 | 268.4 | 66.8 |

Each three-step p95 is its slowest sample; the displayed p95 is the median of
those three per-load values, not a stable tail estimate. Initial index/grid
work and large selection changes remain visible. Raster includes texture
packing/upload, synchronous worker readback and pair compositing, not only
fragment execution. Separately aggregated phase medians need not sum exactly
to the aggregate input latency.

**These results do not claim parity with the old sampled preview.** New
continuous all-row input → fence is 3.8× the old sampled latency on hardware
and 6.6× on SwiftShader; integer is 1.8×/2.1×. Continuous scroll improves about
21×/34× through caching, while software continuous release is about 2.4× slower.
Software dense full-width work remains around two seconds and load → image
about nine seconds: the feasibility prototype did not include all production
footprint, extrema, peak-AA, counting or transport work. The fallback is a
measured ~3.7 completed changed images/second at 1M rows, **not** 60fps or a
claim that all software gestures are fluid. No new 10M capacity claim is made.

The measured optimization trail (one exploratory load × three steps, therefore
not mixed into the final table) explains the production fallback. Initial
SwiftShader continuous quarter-column raster was 1047ms and release raster
about 4632ms. Clipped stubs, analytical center coverage and equivalent CDF
reduced full refinement; typed histogram scratch reduced numeric update
allocation. Before the final 1/16 choice, quarter-column raster was still
474ms and release about 1981ms. Sparse CSR indexing reduced integer brush
raster from 151ms to 52ms without reducing columns. The final three-load table
uses the resulting implementation, not the faster lightweight prototype.

Reproduce after a normal `bun run build`:

```bash
bun build bench/parallel.ts --target=node --packages=external --outfile=./node_modules/.cache/parallel-bench.mjs
node node_modules/.cache/parallel-bench.mjs --quality low --backend hardware --rows 1000000 --reps 3 --steps 3 --label continuous-final --out <after-hardware.json>
node node_modules/.cache/parallel-bench.mjs --quality low --backend swiftshader --rows 1000000 --reps 3 --steps 3 --label continuous-final --out <after-software.json>
```

Raw `before-{hardware,software}.json` and `after-{hardware,software}.json`,
prototype data and exploratory optimization runs remain in the task artifact
directory above. The production CLI calls the software backend `swiftshader`;
the feasibility/capture scripts call it `software`.

### Million-row screenshots and visual limitations

The [task artifact directory](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/>)
contains 24 full-page PNGs, nonblank foreground RGBA buffers and three capture
metadata files: eight exact hardware references, eight new hardware images,
and eight new SwiftShader images. Each set covers continuous/integer ×
straight/curved × idle/mid-drag. Names are
`{exact,continuous}-1m-{continuous,integer}-{straight,curved}-{hardware,software}-{idle,mid-drag}.png`;
there is no separate exact/software set. Metadata confirms `interacting=true`
for mid-drag and one million counted rows/465 bins for every new image. Full
pair images evaluate 799 columns including the outer stubs; software dense
gestures evaluate 84, while sparse integer gestures retain 799. An idle
`evaluatedPairs=0` means cache reuse, not zero contributing rows.

The [capture comparison results](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/capture-comparisons.json>)
use the same fixed two-pixel vertical premultiplied blur and ±10px axis exclusion,
with 1,365,240 compared channels per capture. They are measurements, **not** an
expanded pass threshold for the smaller regression test. Hardware exact is the
reference for both new backends. The actual exact renderer omits antialiasing
during million-row gestures, so mid-drag comparisons include that existing
exact-path difference as well as histogram reconstruction.

| Data / shape / phase | Hardware relative L1 | Software relative L1 | Hardware MAE / 255 | Hardware alpha ratio |
|---|---:|---:|---:|---:|
| Continuous / straight / idle | 0.56% | 0.56% | 0.512 | 0.9967 |
| Continuous / straight / mid-drag | 2.09% | 2.57% | 1.901 | 1.0152 |
| Continuous / curved / idle | 3.81% | 3.81% | 3.625 | 0.9841 |
| Continuous / curved / mid-drag | 4.87% | 4.57% | 4.639 | 0.9869 |
| Integer / straight / idle | 5.48% | 5.48% | 1.796 | 0.9902 |
| Integer / straight / mid-drag | 26.01% | 26.03% | 7.025 | 1.1720 |
| Integer / curved / idle | 58.02% | 58.01% | 41.552 | 0.5208 |
| Integer / curved / mid-drag | 59.79% | 59.78% | 40.904 | 0.5332 |

Visual inspection agrees with the limits rather than hiding them:

- Dense straight idle is close to exact: smooth filled gradients instead of
  the rejected bounded representative lattice. Dense curved mode changes the
  envelope; it does not recreate the exact path's neighbor-conditioned ridges.
- Integer straight bundles retain all actual endpoint combinations, with
  smoother footprints than exact's non-antialiased gesture image. A countable
  set of 8×8 endpoint bundles is real structure, not a 128-row preview.
- **Integer curves differ substantially.** The pair histogram cannot identify
  the neighboring-axis values which spread exact splines into many separate
  curves. Easing concentrates that mass into pair-local bundles, leaving much
  more white space and about half the integrated alpha. This is the approved
  pair-local approximation's visible information loss, not pixel equivalence
  or an improvement in exact-spline fidelity. Choose Exact lines when that
  within-bundle neighbor structure matters.
- Six evaluated columns per dense software gap produce visibly stepped/softened
  brush boundaries and coarse horizontal color transitions while moving. They
  disappear on full-width release. There are no sampled source lines, but the
  measured latency improvement has a visible image-resolution cost.

Representative comparisons:
[exact straight idle](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/exact-1m-continuous-straight-hardware-idle.png>) /
[new straight idle](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/continuous-1m-continuous-straight-hardware-idle.png>),
[exact integer curved drag](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/exact-1m-integer-curved-hardware-mid-drag.png>) /
[new integer curved drag](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/continuous-1m-integer-curved-hardware-mid-drag.png>),
and [software dense curved drag](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/continuous-1m-continuous-curved-software-mid-drag.png>).
The [capture script](<C:/Users/Administrator/AppData/Local/Temp/hb/gpt-continuous/capture.mjs>)
uses the public render loader and actual shape/brush controls. Exact raw readback
redraws synchronously before copying because non-preserved WebGL buffers clear
after page composition; continuous raw data comes from the worker's retained
image. Both paths reject blank readbacks. The first raw-only capture attempt
was blank despite valid PNGs; it was replaced and no blank metrics are reported.

### Full-gate validation

The first mandatory pre-push run passed 118 Python tests and 479 Bun tests,
but only 187/188 instrumented browser tests: the existing order-only equivalence
test timed out at 60 seconds. Its trace showed 46.5 seconds for the first
full-image number-array evaluation/transfer and another 17.8 for the second;
the eventual exact-equality assertion passed after the timeout. Lossless native
PNG transport removes millions of browser-protocol entries while retaining
exact whole-image equality. No test timeout, worker count, pixel tolerance or
gate setting was changed. A focused 12-test rerun passed without skips/retries;
the reorder test took 739ms. Dense GPU fixtures now also include finite-endpoint
stubs and both-missing cells; all six GPU/CPU tolerances and measured differences
remain unchanged.

The second full run again passed 118 Python/479 Bun and 187/188 browser tests;
the corrected image comparison passed under the normal 16-worker load. A
separate pre-existing XY gesture test observed a visible brush, then received a
null bounding box 97ms later. XY scale/resize redraws remove and recreate that
brush node, so a prior visibility assertion cannot protect a separately held
bounding-box handle. The gesture now uses locator-native drag/click actions,
which re-resolve and wait for stable targets, with positive SVG extent checks.
Both original zoom-in and exact zoom-out tick assertions remain unchanged.
The instrumented 16-worker stress run passed all 48 selected gesture runs,
including 16 repetitions of that XY zoom case, before its fix was committed.

The final exact command
`uv run pre-commit run --hook-stage pre-push --all-files` **passed**, including
118 Python tests, 479 Bun tests and all 188 instrumented Playwright tests at
the normal 16-worker setting. The unchanged merged diff-cover gate reports
**92%**: 6,149 of 6,634 mapped changed lines covered (92.69%), compared with
`origin/main` across the full branch. This is not a per-file guarantee: retained
grids and selection/index modules report 100%, the density driver 95.7%, and
the evaluator 66.3%. The existing coverage fixture collects document counters,
not inline-worker counters; actual worker GL execution is checked by the real
GPU/CPU cases but does not add those worker-side binding lines to this report.
No gate, coverage threshold, exclusion or hook was changed.

The gate restored the plain web bundle, then `bun run build` passed for all
four normal web, self-test, Streamlit and library outputs. Generated bundles,
raw benchmark/screenshots, the untracked million-row HTML and local design-hook
files are not part of the source commits. No push, remote, packaging or release
configuration changes were made.
