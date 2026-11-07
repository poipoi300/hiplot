"""tools/merge_lcov.py: path normalization, statement folding and hit merging for diff-cover."""

import json
import re
from pathlib import Path

import pytest

from tools.merge_lcov import fold_statements, main, merge, read_report, read_statement_targets, render


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
    e2e = {"src/a.ts": {1: 5, 2: 0}, "src/b.ts": {1: 1}}
    assert merge([unit, e2e]) == {"src/a.ts": {1: 5, 2: 3}, "src/b.ts": {1: 1}}


def test_a_missed_line_only_one_suite_lists_stays_missed() -> None:
    unit = {"src/a.ts": {10: 3}}
    e2e = {"src/a.ts": {10: 4, 20: 0}}
    assert merge([unit, e2e]) == {"src/a.ts": {10: 7, 20: 0}}


def test_a_file_without_executable_lines_is_rejected_by_name() -> None:
    with pytest.raises(ValueError, match=re.escape("src/types.ts: no report lists an executable line")):
        merge([{"src/types.ts": {}}, {"src/a.ts": {1: 1}}])


def test_continuation_lines_fold_onto_their_statement_with_the_highest_count() -> None:
    # bun lists lines 11-12 of a statement istanbul counts on line 10, and a closing brace on 13.
    unit = {"src/a.ts": {10: 0, 11: 2, 12: 0, 13: 0, 20: 0}}
    targets = {"src/a.ts": {11: 10, 12: 10, 13: 10}}
    assert fold_statements(unit, targets) == {"src/a.ts": {10: 2, 20: 0}}


def test_folded_zero_hit_statements_still_count_as_missed() -> None:
    unit = fold_statements({"src/a.ts": {10: 0, 11: 0, 30: 0}}, {"src/a.ts": {11: 10}})
    e2e = {"src/a.ts": {10: 4}}
    assert merge([unit, e2e]) == {"src/a.ts": {10: 4, 30: 0}}


def test_a_per_line_report_without_a_statement_map_is_rejected() -> None:
    with pytest.raises(ValueError, match=re.escape("No statement map for src/new.ts")):
        fold_statements({"src/new.ts": {1: 1}}, {"src/a.ts": {}})


def test_statement_map_lines_are_read_as_integers(tmp_path: Path) -> None:
    path = write(tmp_path / "statements.json", json.dumps({"src/a.ts": {"11": 10}}))
    assert read_statement_targets(path) == {"src/a.ts": {11: 10}}


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
    write(tmp_path / "web" / "e2e.lcov", "SF:src/a.ts\nDA:1,0\nend_of_record\n")
    assert main(["out/merged.lcov", "py.lcov", f"web/e2e.lcov={tmp_path / 'web'}"]) == 0
    merged = (tmp_path / "out" / "merged.lcov").read_text(encoding="utf-8")
    assert "SF:web/src/a.ts" in merged
    assert "SF:hiplot/x.py" in merged


def test_cli_folds_bun_reports_with_the_statement_map(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    write(tmp_path / "unit.lcov", "SF:src\\a.ts\nDA:4,0\nDA:5,3\nend_of_record\n")
    write(tmp_path / "e2e.lcov", "SF:src/a.ts\nDA:4,0\nend_of_record\n")
    write(tmp_path / "statements.json", json.dumps({"src/a.ts": {"5": 4}}))
    assert main(["merged.lcov", "e2e.lcov", "--bun", "unit.lcov", "--statements", "statements.json"]) == 0
    assert (tmp_path / "merged.lcov").read_text(encoding="utf-8") == (
        "SF:src/a.ts\nDA:4,3\nLF:1\nLH:1\nend_of_record\n"
    )


@pytest.mark.parametrize(
    ("arguments", "message"),
    [(["out.lcov", "--bun", "unit.lcov"], "--bun reports need --statements"), (["out.lcov"], "at least one report")],
)
def test_cli_rejects_incomplete_arguments(
    arguments: list[str], message: str, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit):
        main(arguments)
    assert message in capsys.readouterr().err
