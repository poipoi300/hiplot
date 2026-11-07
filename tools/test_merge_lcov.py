"""tools/merge_lcov.py: path normalization and hit merging for diff-cover."""

from pathlib import Path

import pytest

from tools.merge_lcov import main, merge, read_report, render


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_relative_paths_resolve_against_the_report_root(tmp_path: Path) -> None:
    report = write(tmp_path / "web" / "lcov.info", "SF:src/a.ts\nDA:1,2\nend_of_record\n")
    files = read_report(report, tmp_path / "web", tmp_path)
    assert files == {"web/src/a.ts": {1: 2}}


def test_absolute_backslashed_paths_become_repo_relative_posix(tmp_path: Path) -> None:
    source = tmp_path / "src" / "lib" / "b.ts"
    report = write(tmp_path / "e2e.info", f"SF:{source}\nDA:3,0\nDA:4,1\nend_of_record\n")
    assert read_report(report, tmp_path, tmp_path) == {"src/lib/b.ts": {3: 0, 4: 1}}


def test_a_line_is_covered_when_any_suite_hit_it() -> None:
    unit = {"src/a.ts": {1: 0, 2: 3}}
    e2e = {"src/a.ts": {1: 5, 2: 0, 9: 0}, "src/b.ts": {1: 1}}
    assert merge([unit, e2e]) == {"src/a.ts": {1: 5, 2: 3, 9: 0}, "src/b.ts": {1: 1}}


def test_render_writes_sorted_records_with_line_totals() -> None:
    text = render({"src/z.ts": {2: 0, 1: 4}, "hiplot/a.py": {7: 1}})
    assert text == (
        "SF:hiplot/a.py\nDA:7,1\nLF:1\nLH:1\nend_of_record\nSF:src/z.ts\nDA:1,4\nDA:2,0\nLF:2\nLH:1\nend_of_record\n"
    )


def test_line_record_outside_a_file_record_is_rejected(tmp_path: Path) -> None:
    report = write(tmp_path / "bad.info", "DA:1,1\n")
    with pytest.raises(ValueError, match="before any SF record"):
        read_report(report, tmp_path, tmp_path)


def test_cli_merges_reports_with_their_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    write(tmp_path / "py.lcov", "SF:hiplot\\x.py\nDA:1,1\nend_of_record\n")
    write(tmp_path / "web" / "unit.lcov", "SF:src/a.ts\nDA:1,0\nend_of_record\n")
    assert main(["out/merged.lcov", "py.lcov", f"web/unit.lcov={tmp_path / 'web'}"]) == 0
    merged = (tmp_path / "out" / "merged.lcov").read_text(encoding="utf-8")
    assert "SF:web/src/a.ts" in merged
    assert "SF:hiplot/x.py" in merged
