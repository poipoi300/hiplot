# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import argparse
from typing import Any

from . import experiment as exp
from . import pkginfo
from .fetchers import NoFetcherFound, get_fetchers, load_xp_with_fetchers
from .render import get_index_html_template


def run_server(
    fetchers: list[exp.ExperimentFetcher], host: str = "127.0.0.1", port: int = 5005, debug: bool = False
) -> None:
    """
    Runs the HiPlot server, given a list of ExperimentFetchers:
    functions that convert a URI into a :class:`hiplot.Experiment`
    """
    try:
        from flask import Flask, jsonify, request
        from flask_compress import Compress
    except ImportError as e:
        raise ImportError(
            "Flask is required to run the HiPlot server. Install it with: pip install hiplot-mm[server]"
        ) from e

    app = Flask(__name__)

    @app.route("/")
    def index() -> Any:
        return get_index_html_template()

    @app.route("/data")
    def data() -> Any:
        uri = request.args.get("uri", type=str)
        assert uri is not None
        try:
            xp = load_xp_with_fetchers(fetchers, uri)
            xp.validate()
            return jsonify({"query": uri, "experiment": xp._payload()})
        except NoFetcherFound as e:
            return jsonify({"error": f"No fetcher found for this experiment: {e}"})

    Compress(app)
    app.run(debug=debug, host=host, port=port)


def run_server_main() -> int:
    parser = argparse.ArgumentParser(prog="HiPlot", description="Start HiPlot webserver")
    parser.add_argument("--version", action="version", version=f"{pkginfo.package_name} {pkginfo.__version__}")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5005)
    parser.add_argument(
        "--dev", action="store_true", help="Enable Flask Debug mode (watches for files modifications, etc..)"
    )
    parser.add_argument("fetchers", nargs="*", type=str)
    args = parser.parse_args()
    run_server(fetchers=get_fetchers(args.fetchers), host=args.host, port=args.port, debug=args.dev)
    return 0
