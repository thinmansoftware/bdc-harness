#!/usr/bin/env python3
# test-ascii-autofix.py -- unit tests for ascii-autofix normalize_line().
#
# Asserts the four key behaviors of the TOTAL fixer:
#   1. arrow U+2192          -> "->"  (SUBS mapped)
#   2. em-dash U+2014        -> "--"  (SUBS mapped)
#   3. robot emoji U+1F916   -> ""    (STRIP fallback removes it)
#   4. box-drawing U+2550    -> "-"   (range mapped)
#
# Exit 0 on all pass; exit 1 on any failure.

import importlib.util
import pathlib
import sys


def load_module() -> object:
    """Load ascii-autofix.py as a module without running main()."""
    spec = importlib.util.spec_from_file_location(
        "ascii_autofix",
        pathlib.Path(__file__).parent / "ascii-autofix.py",
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load ascii-autofix.py spec")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    mod = load_module()
    normalize_line = mod.normalize_line  # type: ignore[attr-defined]

    cases = [
        # (label, input, expected_output)
        ("arrow U+2192",        "→ arrow",        "-> arrow"),
        ("em-dash U+2014",      "em—dash",        "em--dash"),
        ("robot emoji U+1F916", "\U0001F916 robot",    " robot"),
        ("box-drawing U+2550",  "═ box",          "- box"),
    ]

    failures: list[str] = []
    for label, inp, expected in cases:
        got = normalize_line(inp)
        if got != expected:
            failures.append(
                "FAIL [%s]: normalize_line(%r) = %r, want %r"
                % (label, inp, got, expected)
            )

    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        return 1
    print("PASS: all %d normalize_line assertions correct" % len(cases))
    return 0


if __name__ == "__main__":
    sys.exit(main())
