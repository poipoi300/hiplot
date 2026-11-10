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
