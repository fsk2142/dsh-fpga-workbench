#!/usr/bin/env python3
"""Compare expected and actual text or hexadecimal values.

Usage:
    python python-data-compare.py EXPECTED ACTUAL [--kind hex|text]

Exit codes:
    0: values match
    1: values differ
    2: invalid arguments or unreadable input
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

MAX_DIFFERENCES = 10


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="strict")


def values(text: str, kind: str) -> list[object]:
    result: list[object] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        if kind == "text":
            result.append(stripped)
            continue
        for token_number, token in enumerate(stripped.split(), 1):
            normalized = token[2:] if token.lower().startswith("0x") else token
            try:
                result.append(int(normalized, 16))
            except ValueError as exc:
                raise ValueError(
                    f"invalid hexadecimal token at line {line_number}, word {token_number}: {token}"
                ) from exc
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("expected", type=Path)
    parser.add_argument("actual", type=Path)
    parser.add_argument("--kind", choices=("hex", "text"), default="hex")
    args = parser.parse_args()

    try:
        expected = values(read_text(args.expected), args.kind)
        actual = values(read_text(args.actual), args.kind)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if expected == actual:
        print(f"MATCH: {len(expected)} values compared")
        return 0

    print(f"MISMATCH: expected {len(expected)} values, actual {len(actual)} values")
    width = max(len(expected), len(actual))
    shown = 0
    for index in range(width):
        left = expected[index] if index < len(expected) else "<missing>"
        right = actual[index] if index < len(actual) else "<missing>"
        if left != right:
            print(f"  index {index}: expected={left!r}, actual={right!r}")
            shown += 1
            if shown >= MAX_DIFFERENCES:
                break
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
