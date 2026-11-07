# HiPlot - High dimensional Interactive Plotting

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

To build from source:

```bash
# Install frontend dependencies
bun install

# Install default contributor dependencies (dev/test)
uv sync

# Build JavaScript bundles
bun run build

# Build Python package
uv build

# Or use the all-in-one build script
./build.sh
```

Common contributor tasks:

```bash
# Run Python tests
uv run pytest

# Build docs (docs deps resolved on-demand)
uv run --no-default-groups --group docs sphinx-build -b html docs docs/_build/html
```

**Output directories:**

- `npm-dist/` - NPM package artifacts
- `dist/` - Python wheel and sdist
- `hiplot/static/built/` - JS bundle included in Python package

**Run the dev server:**

```bash
uv run --extra server hiplot --port 8765
```

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
