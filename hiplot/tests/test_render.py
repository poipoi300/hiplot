# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import unittest.mock
from html.parser import HTMLParser

from bs4 import BeautifulSoup

from ..fetchers_demo import README_DEMOS
from ..render import get_index_html_template, make_experiment_standalone_page


@unittest.mock.patch("hiplot.experiment._is_running_ipython", new=lambda: True)
def test_demos_ipython() -> None:
    for k, v in README_DEMOS.items():
        print(k)
        v().display()


@unittest.mock.patch("streamlit.runtime.exists", return_value=True)
def test_demos_streamlit(_mock: unittest.mock.MagicMock) -> None:
    for k, v in README_DEMOS.items():
        print(k)
        v().display_st(key=f"hiplot{k}a")
        v().display_st(ret="selected_uids", key=f"hiplot{k}b")
        v().display_st(ret=["selected_uids"], key=f"hiplot{k}c")


def test_index_html_valid() -> None:
    """
    Make sure that parsing the HTML with BeautifulSoup goes without error,
    because errors are silently discarded and the page content is altered
    """
    html_template = get_index_html_template()
    html_soup = str(BeautifulSoup(html_template, "html.parser"))

    class MyHTMLParser(HTMLParser):
        def __init__(self, data: str) -> None:
            super().__init__()
            self.content: list[str] = []
            self.feed(data)

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            attrs.sort(key=lambda x: x[0])
            attrs_rendered = " ".join([a[0] + "=" + a[1] if a[1] is not None else a[0] for a in attrs])
            self.content.append(f"<{tag} {attrs_rendered}>")

        def handle_endtag(self, tag: str) -> None:
            self.content.append(f"</{tag}>")

        def handle_data(self, data: str) -> None:
            self.content.append(data.strip())

        def error(self, message: str) -> None:
            raise AssertionError(message)

    parser_actual = MyHTMLParser(html_soup)
    parser_expected = MyHTMLParser(html_template)
    assert parser_actual.content == parser_expected.content


def test_standalone_pages_mount_hiplot_in_a_page_filling_element() -> None:
    page = BeautifulSoup(make_experiment_standalone_page({}), "html.parser")
    mount = page.select_one("body > .hiplot-page")
    assert mount is not None
    assert str(mount["id"]).startswith("hiplot_")
    assert "style" not in mount.attrs
