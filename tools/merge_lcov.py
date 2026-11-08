"""Merge LCOV reports into one, with repo-relative POSIX source paths.

diff-cover matches report paths against git's repo-relative diff paths, but
coverage.py, `bun test`, and nyc each write paths differently (relative,
absolute, backslashed). The same TypeScript file is also covered twice, by the
bun unit tests and by the Playwright suite, so line hits are summed per file
into one record: a line counts as covered when any suite executed it, and a
line any suite calls executable stays in the record, hit or not.

The suites disagree on which lines of a statement are executable. coverage.py
and istanbul (Playwright) count a multi-line statement on its first line only,
while bun lists every physical line it spans, including signatures and closing
braces. bun's lines are therefore folded first, with the map
tools/statement_starts.ts writes: each line onto the first line of the
statement istanbul counts it under, keeping the highest hit count among the
lines folded together. Lines the map marks as holding no code (blank,
comment-only, or TypeScript-only declarations the compiler erases) are
dropped: bun lists them, but no runtime can execute them.

Only line records (DA) are kept; diff-cover reads nothing else.

Usage:
    uv run python tools/merge_lcov.py OUTPUT REPORT[=ROOT] ... \\
        [--bun REPORT[=ROOT] ... --statements STATEMENTS.json]

ROOT is the directory a report's relative paths start from (default: the
repo root, i.e. the current directory).
"""

import argparse
import json
from collections import defaultdict
from collections.abc import Iterable, Mapping
from pathlib import Path

type LineHits = dict[int, int]
#: Per source path, the line each folded line is counted under.
type StatementTargets = dict[str, dict[int, int]]
#: The target of lines without code (`NOT_CODE` in tools/statement_starts.ts).
NOT_CODE = 0


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


def read_statement_targets(path: Path) -> StatementTargets:
    """The map tools/statement_starts.ts writes, with integer line numbers."""
    raw: dict[str, dict[str, int]] = json.loads(path.read_text(encoding="utf-8"))
    return {source: {int(line): target for line, target in lines.items()} for source, lines in raw.items()}


def fold_statements(report: Mapping[str, LineHits], targets: StatementTargets) -> dict[str, LineHits]:
    """Folds every line of a per-line report onto the line its statement is counted under.

    A file whose listed lines all hold no code (a module of types only) has
    nothing to cover and is left out; a file listed without any line at all
    still reaches `merge`, which rejects it.
    """
    folded: dict[str, LineHits] = {}
    for path, hits in report.items():
        if path not in targets:
            raise ValueError(f"No statement map for {path}: add it to the tools/statement_starts.ts run")
        file_targets = targets[path]
        lines: LineHits = {}
        for number, count in hits.items():
            target = file_targets.get(number, number)
            if target == NOT_CODE:
                continue
            lines[target] = max(lines.get(target, 0), count)
        if hits and not lines:
            continue
        folded[path] = lines
    return folded


def merge(reports: Iterable[Mapping[str, LineHits]]) -> dict[str, LineHits]:
    """Sum line hits per source path over every line any report lists."""
    merged: defaultdict[str, LineHits] = defaultdict(dict)
    for report in reports:
        for path, hits in report.items():
            lines = merged[path]
            for number, count in hits.items():
                lines[number] = lines.get(number, 0) + count
    for path, lines in merged.items():
        if not lines:
            raise ValueError(f"{path}: no report lists an executable line")
    return dict(merged)


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
    parser.add_argument("reports", nargs="*", default=[], help="REPORT or REPORT=ROOT, merged as they are")
    parser.add_argument(
        "--bun", action="append", default=[], help="REPORT or REPORT=ROOT listing every line, folded first"
    )
    parser.add_argument("--statements", type=Path, help="statement map from tools/statement_starts.ts")
    args = parser.parse_args(argv)
    if args.bun and args.statements is None:
        parser.error("--bun reports need --statements")
    if not args.reports and not args.bun:
        parser.error("give at least one report")
    repo = Path.cwd().resolve()
    reports = [read_report(*parse_report_argument(argument, repo), repo) for argument in args.reports]
    if args.bun:
        targets = read_statement_targets(args.statements)
        reports.extend(
            fold_statements(read_report(*parse_report_argument(argument, repo), repo), targets) for argument in args.bun
        )
    output: Path = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(merge(reports)), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
