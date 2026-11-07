# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import argparse
import base64
import codecs
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from . import fetchers


def escapejs(val: Any) -> str:
    return json.dumps(str(val))


def render_jinja_html(template_loc: str, file_name: str) -> str:
    import jinja2

    return jinja2.Environment(loader=jinja2.FileSystemLoader(template_loc + "/")).get_template(file_name).render()


def html_inlinize(html: str, replace_local: bool = True) -> str:
    """
    Includes external CSS, JS and images directly in the HTML
    (only for files with a relative path)
    """
    from bs4 import BeautifulSoup

    SUFFIX_TO_TYPE = {
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }
    static_root = str(Path(__file__).parent)
    soup = BeautifulSoup(html, "html.parser")
    for i in soup.find_all("link"):
        href = str(i["href"])
        if href.startswith(("http", "//")):
            continue
        if not replace_local:
            continue

        if i["rel"][0] == "stylesheet":
            if href.startswith("/"):
                href = href[1:]
            file = Path(static_root, href)
            new_tag = soup.new_tag("style")
            new_tag.string = file.read_text(encoding="utf-8")
            i.replace_with(new_tag)
        elif i["rel"][0] == "icon":  # Favicon
            file = Path(static_root, href)
            encoded = base64.b64encode(file.read_bytes()).decode("ascii")
            i["href"] = f"data:{SUFFIX_TO_TYPE[file.suffix]};base64,{encoded}"
    for i in soup.find_all("script"):
        try:
            src = str(i["src"])
        except KeyError:
            continue
        if src.startswith(("http", "//")):
            continue
        if not replace_local:
            continue

        if src.startswith("/"):
            src = src[1:]
        file = Path(static_root, src)
        new_tag = soup.new_tag("script")
        new_tag.string = file.read_text(encoding="utf-8")
        new_tag["type"] = i["type"]
        i.replace_with(new_tag)
    return str(soup)


#: Where the template receives the JSON data block holding the options.
DATA_MARKER = "<!--HIPLOT_DATA-->"


def get_index_html_template() -> str:
    return render_jinja_html(str(Path(__file__).parent / "templates"), "index.html")


def json_for_script_element(value: Any) -> str:
    """Strict JSON that is safe as the text of a <script> element.

    Escaping every "<" keeps "</script>" and "<!--" out of the element; JSON.parse
    reads the escape back as "<".
    """
    return json.dumps(value, allow_nan=False).replace("<", "\\u003c")


def make_experiment_standalone_page(options: dict[str, Any], inline_static: bool = False) -> str:
    """A page rendering HiPlot with `options`, which are embedded as a JSON data block.

    With `inline_static`, the bundle and assets are inlined (see `html_inlinize`)
    before the options are added, so large experiments are never parsed as HTML.
    """
    hiplot_options = {"dataProviderName": "none"}
    hiplot_options.update(options)

    page_id = uuid.uuid4().hex
    data_id = f"hiplot_data_{page_id}"
    index_html = get_index_html_template()
    if inline_static:
        index_html = html_inlinize(index_html)
    index_html = index_html.replace("hiplot_element_id", f"hiplot_{page_id}")
    index_html = index_html.replace(
        DATA_MARKER,
        f'<script type="application/json" id="{data_id}">{json_for_script_element(hiplot_options)}</script>',
    )
    return index_html.replace(
        "/*ON_LOAD_SCRIPT_INJECT*/",
        f"""/*ON_LOAD_SCRIPT_INJECT*/
        Object.assign(options, JSON.parse(document.getElementById({escapejs(data_id)}).textContent));
        """,
    )


def hiplot_render_main() -> int:
    parser = argparse.ArgumentParser(
        prog="HiPlot", description="Render an HiPlot experiment to HTML or CSV in the standard output"
    )
    parser.add_argument("experiment_uri", type=str)
    parser.add_argument("--format", default="html", choices=["csv", "html"], help="File format")
    parser.add_argument("fetchers", nargs="*", type=str, help="Additional fetchers to use")
    args = parser.parse_args()

    exp = fetchers.load_xp_with_fetchers(fetchers.get_fetchers(args.fetchers), args.experiment_uri)
    exp.validate()
    stdout_writer = codecs.getwriter("utf-8")(sys.stdout.buffer)
    match args.format:
        case "csv":
            exp.to_csv(stdout_writer)
        case "html":
            exp.to_html(stdout_writer)
        case unknown:
            raise ValueError(f"Unsupported format: {unknown}")
    return 0
