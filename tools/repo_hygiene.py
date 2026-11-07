"""Local reimplementations of the pre-commit-hooks checks.

Kept in-repo instead of pulling https://github.com/pre-commit/pre-commit-hooks
so the hook chain has zero network dependency. Each function is one check;
main() dispatches to one by subcommand name and exits non-zero on failure.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import yaml

_MERGE_CONFLICT_MARKERS = re.compile(rb"^(<<<<<<<|=======|>>>>>>>)( |$)", re.MULTILINE)
_DEBUG_STATEMENT = re.compile(r"\b(breakpoint\(\)|pdb\.set_trace\(\)|ipdb\.set_trace\(\))")
_PRIVATE_KEY = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")


def trailing_whitespace(paths: list[str]) -> int:
    """Strip trailing whitespace from each line, rewriting files in place."""
    failed = 0
    for p in paths:
        path = Path(p)
        text = path.read_text(encoding="utf-8", errors="ignore")
        fixed = "\n".join(line.rstrip() for line in text.split("\n"))
        if fixed != text:
            path.write_text(fixed, encoding="utf-8", newline="")
            print(f"fixed trailing whitespace: {p}")
            failed = 1
    return failed


def end_of_file_fixer(paths: list[str]) -> int:
    """Ensure each file ends with exactly one trailing newline."""
    failed = 0
    for p in paths:
        path = Path(p)
        data = path.read_bytes()
        if not data:
            continue
        fixed = data.rstrip(b"\n") + b"\n"
        if fixed != data:
            path.write_bytes(fixed)
            print(f"fixed end-of-file newline: {p}")
            failed = 1
    return failed


def check_merge_conflict(paths: list[str]) -> int:
    """Fail if any file still contains unresolved <<<<<<< / ==== / >>>>>>> markers."""
    failed = 0
    for p in paths:
        if _MERGE_CONFLICT_MARKERS.search(Path(p).read_bytes()):
            print(f"merge conflict markers found: {p}")
            failed = 1
    return failed


def check_case_conflict(_paths: list[str]) -> int:
    """Fail if two tracked files differ only by case (breaks on case-insensitive FS)."""
    result = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    seen: dict[str, str] = {}
    failed = 0
    for tracked in result.stdout.splitlines():
        key = tracked.lower()
        if key in seen and seen[key] != tracked:
            print(f"case-insensitive filename collision: {tracked} vs {seen[key]}")
            failed = 1
        seen[key] = tracked
    return failed


def check_added_large_files(paths: list[str], max_kb: int) -> int:
    """Fail if any file exceeds max_kb (stops stray model weights / image dumps)."""
    failed = 0
    limit = max_kb * 1024
    for p in paths:
        size = Path(p).stat().st_size
        if size > limit:
            print(f"{p} is {size / 1024:.0f} KB (limit {max_kb} KB)")
            failed = 1
    return failed


def check_yaml(paths: list[str]) -> int:
    """Fail if a .yaml/.yml file doesn't parse."""
    failed = 0
    for p in paths:
        try:
            list(yaml.safe_load_all(Path(p).read_text(encoding="utf-8")))
        except yaml.YAMLError as e:
            print(f"invalid YAML: {p}: {e}")
            failed = 1
    return failed


def check_toml(paths: list[str]) -> int:
    """Fail if a .toml file doesn't parse."""
    failed = 0
    for p in paths:
        try:
            tomllib.loads(Path(p).read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as e:
            print(f"invalid TOML: {p}: {e}")
            failed = 1
    return failed


def check_json(paths: list[str]) -> int:
    """Fail if a .json file doesn't parse."""
    failed = 0
    for p in paths:
        try:
            json.loads(Path(p).read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"invalid JSON: {p}: {e}")
            failed = 1
    return failed


def debug_statements(paths: list[str]) -> int:
    """Fail on leftover debugger-breakpoint calls (breakpoint, pdb/ipdb set_trace)."""
    failed = 0
    for p in paths:
        text = Path(p).read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if _DEBUG_STATEMENT.search(line):
                print(f"{p}:{lineno}: debug statement left in code")
                failed = 1
    return failed


def detect_private_key(paths: list[str]) -> int:
    """Fail if a PEM-format private key block is present."""
    failed = 0
    for p in paths:
        if _PRIVATE_KEY.search(Path(p).read_bytes()):
            print(f"possible private key committed: {p}")
            failed = 1
    return failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "check",
        choices=[
            "trailing-whitespace",
            "end-of-file-fixer",
            "check-merge-conflict",
            "check-case-conflict",
            "check-added-large-files",
            "check-yaml",
            "check-toml",
            "check-json",
            "debug-statements",
            "detect-private-key",
        ],
    )
    parser.add_argument("--max-kb", type=int, default=2048)
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()

    handlers = {
        "trailing-whitespace": lambda: trailing_whitespace(args.paths),
        "end-of-file-fixer": lambda: end_of_file_fixer(args.paths),
        "check-merge-conflict": lambda: check_merge_conflict(args.paths),
        "check-case-conflict": lambda: check_case_conflict(args.paths),
        "check-added-large-files": lambda: check_added_large_files(args.paths, args.max_kb),
        "check-yaml": lambda: check_yaml(args.paths),
        "check-toml": lambda: check_toml(args.paths),
        "check-json": lambda: check_json(args.paths),
        "debug-statements": lambda: debug_statements(args.paths),
        "detect-private-key": lambda: detect_private_key(args.paths),
    }
    return handlers[args.check]()


if __name__ == "__main__":
    sys.exit(main())
