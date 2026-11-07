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
  brushing holds the 120 Hz frame clock with no stall, and lines are complete
  within 2 ms of releasing the mouse.
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
sooner, a full redraw is about 400x faster, brushing holds the 120 Hz frame
clock, and the lines are final 2 ms after the mouse is released instead of
2.7 s. The density pass costs nothing measurable against step 7: the GPU
time of both passes is well inside one frame.
