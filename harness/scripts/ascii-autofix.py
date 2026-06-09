#!/usr/bin/env python3
# ascii-autofix.py -- Rule 13 mechanical normalizer.
#
# Usage: python3 harness/scripts/ascii-autofix.py <BASE_SHA>
#
# Purpose: Replace a small, deterministic set of mapped non-ASCII characters
# before the downstream ascii-gate runs. The gate remains the load-bearing
# backstop and still fails on any unmapped non-ASCII, including emoji.
#
# Scope must match ascii-gate's file set:
# - files changed from BASE..HEAD
# - tracked/staged/uncommitted edits from git diff HEAD
# - untracked files from git ls-files --others --exclude-standard
#
# Safety lines:
# - Only applies SUBS below. No blind-strip. No '?' replacement.
# - For tracked files, only rewrites added/changed lines from the committed
#   diff and working-tree diff. For untracked files, all lines are eligible.
# - Emoji and any glyph not in SUBS fall through untouched for ascii-gate.
#
# Output: one filename per line for each file actually modified.
# Exit 0 always; errors go to stderr and ascii-gate is the backstop.

from __future__ import annotations

import os
import re
import subprocess
import sys

SUBS = {
    chr(0x2014): "--",   # em dash
    chr(0x2013): "--",   # en dash
    chr(0x2018): "'",    # left single quote
    chr(0x2019): "'",    # right single quote
    chr(0x201C): '"',    # left double quote
    chr(0x201D): '"',    # right double quote
    chr(0x2026): "...",  # ellipsis
    chr(0x00A0): " ",    # non-breaking space
    chr(0x2212): "-",    # Unicode minus
}

SRC_RE = re.compile(r"\.(js|jsx|ts|tsx|mjs|cjs|html|sh|bash|gs|yaml|yml)$")
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def run_git(args: list[str]) -> tuple[str, int]:
    try:
        proc = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0 and proc.stderr:
            sys.stderr.write(
                "ascii-autofix: git %s failed: %s\n"
                % (" ".join(args), proc.stderr.strip())
            )
        return proc.stdout, proc.returncode
    except Exception as exc:
        sys.stderr.write("ascii-autofix: git exec error: %s\n" % exc)
        return "", 1


def git_ok(args: list[str]) -> bool:
    _, rc = run_git(args)
    return rc == 0


def source_files_from_gate_scope(base: str | None) -> list[str]:
    parts: list[str] = []
    if base:
        out, _ = run_git(["diff", "--name-only", "%s..HEAD" % base])
        parts.append(out)
    out, _ = run_git(["diff", "--name-only", "HEAD"])
    parts.append(out)
    out, _ = run_git(["ls-files", "--others", "--exclude-standard"])
    parts.append(out)

    seen: set[str] = set()
    files: list[str] = []
    for line in "\n".join(parts).splitlines():
        path = line.strip()
        if not path or path in seen:
            continue
        seen.add(path)
        if SRC_RE.search(path):
            files.append(path)
    return files


def is_untracked(path: str) -> bool:
    proc = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode != 0


def added_lines_from_diff(args: list[str]) -> set[int]:
    diff, rc = run_git(args)
    if rc != 0 or not diff.strip():
        return set()

    added: set[int] = set()
    cur_new = 0
    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("@@"):
            match = HUNK_RE.match(line)
            if not match:
                in_hunk = False
                continue
            cur_new = int(match.group(1))
            in_hunk = True
            continue
        if not in_hunk:
            continue
        if line.startswith("+++"):
            continue
        if line.startswith("+"):
            added.add(cur_new)
            cur_new += 1
            continue
        if line.startswith("-") or line.startswith("\\"):
            continue
        cur_new += 1
    return added


def eligible_lines(base: str | None, path: str) -> set[int] | None:
    if is_untracked(path):
        return None

    lines: set[int] = set()
    if base:
        lines.update(
            added_lines_from_diff(["diff", "--unified=0", "%s..HEAD" % base, "--", path])
        )
    lines.update(added_lines_from_diff(["diff", "--unified=0", "HEAD", "--", path]))
    return lines


def normalize_line(line: str) -> str:
    if not any(ch in line for ch in SUBS):
        return line
    return "".join(SUBS.get(ch, ch) for ch in line)


def fix_file(path: str, lines_to_fix: set[int] | None) -> bool:
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
            raw = handle.read()
    except OSError as exc:
        sys.stderr.write("ascii-autofix: cannot read %s: %s\n" % (path, exc))
        return False

    lines = raw.splitlines(keepends=True)
    changed = False
    for index, line in enumerate(lines):
        lineno = index + 1
        if lines_to_fix is not None and lineno not in lines_to_fix:
            continue
        new_line = normalize_line(line)
        if new_line != line:
            lines[index] = new_line
            changed = True

    if not changed:
        return False

    try:
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("".join(lines))
    except OSError as exc:
        sys.stderr.write("ascii-autofix: cannot write %s: %s\n" % (path, exc))
        return False
    return True


def resolve_base(argv: list[str]) -> str | None:
    if len(argv) < 2:
        sys.stderr.write("ascii-autofix: usage: ascii-autofix.py <BASE_SHA>\n")
        return None
    base = argv[1].strip()
    if not base or base == "unknown":
        sys.stderr.write("ascii-autofix: empty or unknown BASE_SHA; using working-tree scope\n")
        return None
    if not git_ok(["rev-parse", "--verify", base]):
        sys.stderr.write("ascii-autofix: BASE_SHA %s not resolvable; using working-tree scope\n" % base)
        return None
    return base


def main(argv: list[str]) -> int:
    base = resolve_base(argv)
    modified: list[str] = []
    for path in source_files_from_gate_scope(base):
        if not os.path.isfile(path):
            continue
        if fix_file(path, eligible_lines(base, path)):
            modified.append(path)

    for path in modified:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
