# Rendering performance

This page records how fast HiPlot renders large experiments, so every change
to the rendering path is measured against the same numbers.

## Method

`bench/make_experiments.py` generates three seeded experiments and renders
each to a standalone HTML page:

| Size | Rows | Columns | Column mix |
|---|---|---|---|
| 5k × 20 | 5,000 | 20 | linear numeric, log-scale numeric (seven decades), categorical (3 to 12 values), sparse numeric with 2% inf and 3% NaN |
| 20k × 30 | 20,000 | 30 | same rotation |
| 50k × 50 | 50,000 | 50 | same rotation |
| 100k × 30 | 100,000 | 30 | same rotation (measured from the second round on; `--sizes 100000x30`) |

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
