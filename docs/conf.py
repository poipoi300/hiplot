# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""Sphinx configuration for the HiPlot documentation.

Sphinx executes this file with the current directory set to `docs/`.
"""

import sys
from pathlib import Path

import guzzle_sphinx_theme

# autodoc imports `hiplot` from the repository checkout, not from site-packages.
sys.path.insert(0, str(Path("..").resolve()))

import hiplot.pkginfo  # importable only after the path insert above

extensions = [
    "sphinx.ext.autodoc",
    "sphinx.ext.doctest",
    "sphinx.ext.todo",
    "sphinx.ext.coverage",
    "sphinx.ext.viewcode",
    "sphinx.ext.githubpages",
    "m2r2",
    "guzzle_sphinx_theme",  # registered as an extension so it generates sitemap.xml
]
templates_path = ["_templates"]
source_suffix = {
    ".rst": "restructuredtext",
    ".md": "markdown",
}
master_doc = "index"

project = "HiPlot"
copyright = "2020, Facebook AI Research (FAIR)"
author = "Facebook AI Research (FAIR)"
github_doc_root = "https://github.com/poipoi300/hiplot"

release = hiplot.pkginfo.__version__
version = ".".join(release.split(".")[:2])
language = "en"

exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]
pygments_style = "sphinx"
todo_include_todos = True

html_favicon = "../hiplot/static/icon.png"
html_theme_path = guzzle_sphinx_theme.html_theme_path()
html_theme = "guzzle_sphinx_theme"
html_theme_options = {
    "project_nav_name": "HiPlot",
    "base_url": "https://poipoi300.github.io/hiplot/",
}
html_static_path = ["_static"]
html_sidebars = {"**": ["logo-text.html", "globaltoc.html", "searchbox.html"]}
htmlhelp_basename = "HiPlotdoc"

# External sites that frequently block automated link check user agents.
linkcheck_ignore = [
    r"https://www\.npmjs\.com/package/hiplot-plus",
]

latex_documents = [
    (master_doc, "HiPlot.tex", "HiPlot Documentation", "Daniel Haziza", "manual"),
]
man_pages = [(master_doc, "hiplot", "HiPlot Documentation", [author], 1)]
texinfo_documents = [
    (
        master_doc,
        "HiPlot",
        "HiPlot Documentation",
        author,
        "HiPlot",
        "High dimensional interactive plotting.",
        "Miscellaneous",
    ),
]
