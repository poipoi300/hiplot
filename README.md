# HiPlot - High dimensional Interactive Plotting

## About this fork

Thanks to [Facebook Research](https://github.com/facebookresearch/hiplot) for creating HiPlot, and to [Mind the Math](https://github.com/mindthemath/hiplot) for keeping it alive after the original was archived. This fork builds on their work; it is not affiliated with either.

What changed:

- **Rendering:** WebGL2 density lines with exact anti-aliasing and colors mapped by value, with a choice of what overlapping lines show (mean, lowest or highest). 100,000 rows by 30 columns stay interactive.
- **Parallel plot:** several brushes per axis, value tags on brushes, axes that face the color gradient (high colors at the top), horizontal scrolling with middle-click autoscroll, spline lines and a searchable Columns menu.
- **Scatter plots:** XY, one-axis and 3D panels with lasso selection, a shared axis picker and correlation and regression fits.
- **Table:** multi-level sorting, column filters and aligned numbers.
- **Look:** a redesigned light and dark theme, colorblind-safe palettes and a color legend.
- **Data:** compact columnar transfer, NaN, inf and missing-value spellings read as such, numeric uids.
- **Example:** a real GPU hyperparameter search in [examples/hptuning](examples/hptuning), with trials stored as Parquet.
- **Engineering:** Python 3.12 to 3.15, ruff and mypy --strict, TypeScript strict and Biome, Playwright browser tests, and commit and push gates requiring 90% coverage of changed lines across all suites.


![Logo](https://raw.githubusercontent.com/mindthemath/hiplot/main/hiplot/static/logo.png)

[![CI](https://github.com/mindthemath/hiplot/actions/workflows/ci.yml/badge.svg)](https://github.com/mindthemath/hiplot/actions/workflows/ci.yml)
[![Release](https://github.com/mindthemath/hiplot/actions/workflows/release.yml/badge.svg)](https://github.com/mindthemath/hiplot/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![PyPI version](https://img.shields.io/pypi/v/hiplot-mm.svg)](https://pypi.python.org/pypi/hiplot-mm/)
[![PyPI downloads](https://img.shields.io/pypi/dm/hiplot-mm.svg)](https://pypi.python.org/pypi/hiplot-mm/)
[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/mindthemath/hiplot/blob/main/examples/HiPlotColabExample.ipynb)

> **Community-maintained fork**: This is a community-maintained fork of [Facebook Research's HiPlot](https://github.com/facebookresearch/hiplot), which has been archived. We aim to keep the project alive with bug fixes, security updates, and new features.

HiPlot is a lightweight interactive visualization tool to help AI researchers discover correlations and patterns in high-dimensional data using parallel plots and other graphical ways to represent information.

### [Try a demo now with sweep data](https://mindthemath.github.io/hiplot/_static/demo/ml1.csv.html) or [upload your CSV](https://mindthemath.github.io/hiplot/_static/hiplot_upload.html) or [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/mindthemath/hiplot/blob/main/examples/HiPlotColabExample.ipynb)

There are several modes to HiPlot:

- As a web-server (if your data is a CSV for instance)
- In a jupyter notebook (to visualize python data), or in [Streamlit apps](https://mindthemath.github.io/hiplot/tuto_streamlit.html)
- In CLI to render standalone HTML

## Quick Start

```bash
# Render a CSV to interactive HTML (no install needed)
uvx hiplot-mm data.csv > output.html

# Or start an interactive server
uvx --from 'hiplot-mm[server]' hiplot --port 8765
```

## Installation

```bash
# Core package (HTML export, CLI rendering)
pip install hiplot-mm

# With Jupyter notebook support
pip install hiplot-mm[notebook]

# With web server support (hiplot command)
pip install hiplot-mm[server]

# With Streamlit support
pip install hiplot-mm[streamlit]

# Everything
pip install hiplot-mm[all]
```

If you have a Jupyter notebook, you can get started with something as simple as:

```python
import hiplot as hip

data = [
    {"dropout": 0.1, "lr": 0.001, "loss": 10.0, "optimizer": "SGD"},
    {"dropout": 0.15, "lr": 0.01, "loss": 3.5, "optimizer": "Adam"},
    {"dropout": 0.3, "lr": 0.1, "loss": 4.5, "optimizer": "Adam"},
]
hip.Experiment.from_iterable(data).display()
```

### [See the live result](https://mindthemath.github.io/hiplot/_static/demo/demo_basic_usage.html)

![Result](https://raw.githubusercontent.com/mindthemath/hiplot/main/assets/notebook.png)

## Links

- Repository: https://github.com/mindthemath/hiplot
- Documentation: https://mindthemath.github.io/hiplot/
- PyPI package: https://pypi.org/project/hiplot-mm/
- Examples: https://github.com/mindthemath/hiplot/tree/main/examples
- Original blog post: https://ai.facebook.com/blog/hiplot-high-dimensional-interactive-plots-made-easy/

## Development

HiPlot is Python 3.12+ (built with [uv](https://docs.astral.sh/uv/)) plus a
TypeScript frontend (React, d3, built with [Bun](https://bun.sh) and Vite).
Contributor rules, including for coding agents, are in [AGENTS.md](AGENTS.md).

```bash
bun install && uv sync          # dependencies
bun run build                   # JavaScript bundles into hiplot/static/built/
uv run pre-commit install -t pre-commit -t pre-push   # quality gates, once
uv run --extra server hiplot --port 8765              # dev server (load `demo`)
```

| Task | Command |
|---|---|
| Python tests | `uv run pytest` |
| Frontend unit tests | `bun test` |
| End-to-end tests (Playwright) | `bun run test:js` |
| Format and lint | `uv run ruff format . && uv run ruff check .` · `bun run biome check --write .` |
| Type checks | `uv run mypy .` · `bun run typecheck` |
| Every commit gate | `uv run pre-commit run --all-files` |
| Tests + 90% diff coverage (push gate) | `bash tools/stack_coverage_gate.sh` |
| Rendering benchmark | `bash bench/run.sh` (results in [docs/PERFORMANCE.md](docs/PERFORMANCE.md)) |
| Docs | `uv run --no-default-groups --group docs sphinx-build -b html docs docs/_build/html` |
| Package | `bun run build && uv build` (or `./build.sh`, which also emits the npm types) |

Commits run the fast gates (hygiene, ruff, mypy --strict, Biome, tsc
--strict); pushes run pytest, `bun test` and Playwright under coverage and
require 90% coverage of changed lines. CI runs the same gates plus Python
3.12 to 3.15, Windows, package installs and the docs build.

**Output directories:** `hiplot/static/built/` (bundles shipped in the
wheel), `dist/` (wheel and sdist), `npm-dist/` (npm package).

## Citing

```bibtex
@misc{hiplot,
    author = {Haziza, D. and Rapin, J. and Synnaeve, G.},
    title = {{Hiplot, interactive high-dimensionality plots}},
    year = {2020},
    publisher = {GitHub},
    journal = {GitHub repository},
    howpublished = {\url{https://github.com/facebookresearch/hiplot}},
}
```

## Credits

Inspired by and based on code from [Kai Chang](http://bl.ocks.org/syntagmatic/3150059), [Mike Bostock](http://bl.ocks.org/1341021) and [Jason Davies](http://bl.ocks.org/1341281).

External contributors (_please add your name when you submit your first pull request_):

- [louismartin](https://github.com/louismartin)
- [GoldenCorgi](https://github.com/GoldenCorgi)
- [callistachang](https://github.com/callistachang)

## License

HiPlot is [MIT](LICENSE) licensed, as found in the [LICENSE](LICENSE) file.
