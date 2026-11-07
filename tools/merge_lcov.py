"""Merge LCOV reports into one, with repo-relative POSIX source paths.

diff-cover matches report paths against git's repo-relative diff paths, but
coverage.py, `bun test`, and nyc each write paths differently (relative,
absolute, backslashed). The same TypeScript file is also covered twice, by the
bun unit tests and by the Playwright suite, so line hits are summed per file
into one record: a line counts as covered when any suite executed it.

The suites disagree on which lines are executable. coverage.py and istanbul
(Playwright) count a multi-line statement on its first line only, while bun
counts every physical line it spans. Unioning the line sets would report the
continuation lines of a statement the browser ran as missed whenever bun only
imported the file. A file reported by several suites therefore keeps just the
lines all of them call executable.

Only line records (DA) are kept; diff-cover reads nothing else.

Usage:
    uv run python tools/merge_lcov.py OUTPUT REPORT[=ROOT] [REPORT[=ROOT] ...]

ROOT is the directory a report's relative paths start from (default: the
repo root, i.e. the current directory).
"""

import argparse
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

type LineHits = dict[int, int]


def read_report(report: Path, root: Path, repo: Path) -> dict[str, LineHits]:
    """Line hits per repo-relative source path in one LCOV report."""
    files: dict[str, LineHits] = {}
    current: LineHits | None = None
    for line in report.read_text(encoding="utf-8").splitlines():
        if line.startswith("SF:"):
            # Backslashes are Windows separators; no real source path contains one.
            source = Path(line.removeprefix("SF:").replace("\\", "/"))
            absolute = source if source.is_absolute() else root / source
            current = files.setdefault(absolute.resolve().relative_to(repo).as_posix(), {})
        elif line.startswith("DA:"):
            if current is None:
                raise ValueError(f"{report}: DA record before any SF record")
            number, hits = line.removeprefix("DA:").split(",")[:2]
            current[int(number)] = current.get(int(number), 0) + int(hits)
        elif line == "end_of_record":
            current = None
    return files


def merge(reports: Iterable[dict[str, LineHits]]) -> dict[str, LineHits]:
    """Sum line hits per source path over the lines every covering report lists."""
    per_path: defaultdict[str, list[LineHits]] = defaultdict(list)
    for report in reports:
        for path, hits in report.items():
            per_path[path].append(hits)
    merged: dict[str, LineHits] = {}
    for path, reported in per_path.items():
        executable = set.intersection(*(set(hits) for hits in reported))
        merged[path] = {number: sum(hits[number] for hits in reported) for number in executable}
    return merged


def render(files: dict[str, LineHits]) -> str:
    """LCOV text with one record per file, files and lines in sorted order."""
    out: list[str] = []
    for path in sorted(files):
        hits = files[path]
        out.append(f"SF:{path}")
        out.extend(f"DA:{number},{hits[number]}" for number in sorted(hits))
        out.append(f"LF:{len(hits)}")
        out.append(f"LH:{sum(1 for count in hits.values() if count > 0)}")
        out.append("end_of_record")
    return "\n".join(out) + "\n"


def parse_report_argument(argument: str, repo: Path) -> tuple[Path, Path]:
    report, _, root = argument.partition("=")
    return Path(report), (Path(root).resolve() if root else repo)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("output", type=Path)
    parser.add_argument("reports", nargs="+", help="REPORT or REPORT=ROOT")
    args = parser.parse_args(argv)
    repo = Path.cwd().resolve()
    sources = [parse_report_argument(argument, repo) for argument in args.reports]
    merged = merge(read_report(report, root, repo) for report, root in sources)
    output: Path = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(merged), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
