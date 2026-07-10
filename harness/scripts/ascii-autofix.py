#!/usr/bin/env python3
# ascii-autofix.py -- Rule 13 mechanical normalizer (TOTAL fixer).
#
# Usage:
#   python3 harness/scripts/ascii-autofix.py --files-from <PATH>
#   python3 harness/scripts/ascii-autofix.py <BASE_SHA>  # legacy compatibility
#
# Purpose: Convert EVERY non-ASCII byte in the gate's scope to ASCII so the
# downstream ascii-gate becomes a no-fail verification. There are two tiers:
#
#   Tier 1: SUBS (semantic map). Known glyphs are replaced by their ASCII
#           equivalent (em-dash -> --, arrow -> ->, box-drawing -> -, etc.).
#           See _subs_lookup() for the full table + the U+2500..U+257F range.
#
#   Tier 2: STRIP fallback. Any codepoint >= 0x80 with no SUBS entry (emoji,
#           variation selectors U+FE0F, zero-width joiners, any stray glyph)
#           is REMOVED. Every stripped codepoint is logged to stderr as
#           file:line:U+XXXX so a human reviewing the PR sees what decoration
#           was discarded. Strip is silent in effect, never in record.
#
# After both tiers the output is guaranteed pure ASCII by construction, so the
# gate that runs next cannot fail on agent-leaked non-ASCII.
#
# Normal workflow scope comes from --files-from. The workflow derives that sorted,
# immutable list once, and both this fixer and ascii-gate consume the same bytes.
# The positional BASE_SHA mode remains only for compatibility with older callers.
#
# Safety lines:
# - Only files matching SRC_RE are touched (source code extensions).
# - All lines in every changed file are normalized (whole-file scope), matching
#   the gate's whole-file scan. Diff-scoped normalization was abandoned in
#   WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01 because the gate's grep
#   inspects the entire file, so pre-existing non-ASCII bytes on untouched lines
#   would otherwise survive autofix and trip the gate on a clean ASCII diff.
# - `\uXXXX` escape literals in source files are already ASCII bytes on disk
#   and pass through both tiers untouched -- this is the correct pattern when
#   source code must reference a Unicode codepoint (e.g. in a test assertion).
#
# Output: one filename per line for each file actually modified.
# Exit 0 always; errors go to stderr and ascii-gate is the backstop.

from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys

# SUBS: semantic mapping from known non-ASCII codepoints to ASCII equivalents.
# Box-drawing range U+2500..U+257F is handled by _subs_lookup() (128 codepoints,
# too many for individual dict entries; all collapse to "-").
SUBS = {
    chr(0x2014): "--",         # em dash
    chr(0x2013): "--",         # en dash
    chr(0x2018): "'",          # left single quote
    chr(0x2019): "'",          # right single quote
    chr(0x201C): '"',          # left double quote
    chr(0x201D): '"',          # right double quote
    chr(0x2026): "...",        # ellipsis
    chr(0x00A0): " ",          # non-breaking space
    chr(0x2212): "-",          # Unicode minus
    chr(0x2192): "->",         # rightwards arrow
    chr(0x2190): "<-",         # leftwards arrow
    chr(0x2191): "^",          # upwards arrow
    chr(0x2193): "v",          # downwards arrow
    chr(0x00A7): "Section ",   # section sign
    chr(0x00B7): "-",          # middle dot
    chr(0x2022): "-",          # bullet
    chr(0x2713): "[x]",        # check mark
    chr(0x2717): "[ ]",        # ballot x
    chr(0x2705): "[x]",        # white heavy check mark
    chr(0x274C): "[ ]",        # cross mark
    chr(0x2265): ">=",         # greater-than or equal to
    chr(0x2264): "<=",         # less-than or equal to
    chr(0x26A0): "!",          # warning sign
}

SRC_RE = re.compile(r"\.(js|jsx|ts|tsx|mjs|cjs|html|sh|bash|gs|yaml|yml)$")
# dead code -- whole-file normalization used; see WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _subs_lookup(ch: str) -> str:
    """Tier 1 lookup. Returns ASCII replacement for known glyphs, else ch unchanged.

    Box-drawing range U+2500..U+257F collapses to '-' (banners become dashes)."""
    if ch in SUBS:
        return SUBS[ch]
    cp = ord(ch)
    if 0x2500 <= cp <= 0x257F:
        return "-"
    return ch


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


class ScopeFileError(ValueError):
    """The authoritative scope artifact is missing, invalid, or unsafe."""


def source_files_from_manifest(manifest: str) -> tuple[pathlib.Path, list[str]]:
    """Read a fail-closed source-file list rooted in the current Git repository."""
    root_out, root_rc = run_git(["rev-parse", "--show-toplevel"])
    if root_rc != 0 or not root_out.strip():
        raise ScopeFileError("scope_authority_missing: repository root unavailable")
    root = pathlib.Path(root_out.strip()).resolve()

    manifest_path = pathlib.Path(manifest).resolve()
    if not manifest_path.is_file():
        raise ScopeFileError("scope_authority_missing: files-from list is missing")

    try:
        raw_lines = manifest_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ScopeFileError("scope_authority_missing: cannot read files-from list: %s" % exc)

    seen: set[str] = set()
    files: list[str] = []
    for raw in raw_lines:
        path = raw.strip()
        if not path:
            continue
        listed = pathlib.Path(path)
        if listed.is_absolute() or ".." in listed.parts:
            raise ScopeFileError("outside repository: %s" % path)
        resolved = (root / listed).resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            raise ScopeFileError("outside repository: %s" % path)
        relative = listed.as_posix()
        if relative in seen:
            raise ScopeFileError("duplicate scope file: %s" % relative)
        if not SRC_RE.search(relative):
            raise ScopeFileError("unsupported scope file: %s" % relative)
        if not resolved.is_file():
            raise ScopeFileError("missing scope file: %s" % relative)
        seen.add(relative)
        files.append(relative)
    return root, files


# dead code -- whole-file normalization used; see WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01
def is_untracked(path: str) -> bool:
    proc = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode != 0


# dead code -- whole-file normalization used; see WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01
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


# dead code -- whole-file normalization used; see WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01
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


def normalize_line(line: str, path: str = "", lineno: int = 0) -> str:
    """Total normalizer: SUBS+STRIP. Output is guaranteed pure ASCII.

    Fast path: lines that are already pure ASCII return unchanged.
    Otherwise, each character is mapped via _subs_lookup. If the mapped result
    is still >= 0x80 (no SUBS entry), it is STRIPPED and logged to stderr."""
    # Fast path: already pure ASCII -- no work to do.
    if all(ord(c) < 128 for c in line):
        return line
    out: list[str] = []
    for ch in line:
        mapped = _subs_lookup(ch)
        # mapped is a string (possibly multi-char from SUBS). Append every char
        # that is ASCII; strip any non-ASCII remainder.
        for mc in mapped:
            if ord(mc) < 128:
                out.append(mc)
            else:
                # STRIP fallback: log and discard.
                if path:
                    sys.stderr.write(
                        "ascii-autofix: %s:%d:U+%04X stripped\n"
                        % (path, lineno, ord(mc))
                    )
                else:
                    sys.stderr.write(
                        "ascii-autofix: U+%04X stripped\n" % ord(mc)
                    )
    return "".join(out)


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
        new_line = normalize_line(line, path, lineno)
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
        sys.stderr.write("ascii-autofix: legacy usage requires <BASE_SHA>\n")
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
    if len(argv) == 3 and argv[1] == "--files-from":
        try:
            root, files = source_files_from_manifest(argv[2])
        except ScopeFileError as exc:
            sys.stderr.write("ascii-autofix: %s\n" % exc)
            return 2
        os.chdir(root)
    elif len(argv) == 2 and argv[1] != "--files-from":
        base = resolve_base(argv)
        files = source_files_from_gate_scope(base)
    else:
        sys.stderr.write(
            "ascii-autofix: usage: ascii-autofix.py --files-from <PATH>\n"
        )
        return 2

    modified: list[str] = []
    for path in files:
        # whole-file scope: None means normalize every line, not just added lines (WO-HARNESS-BDF-RESILIENCE-FIX-D-ASCII-AUTOFIX-01)
        if fix_file(path, None):
            modified.append(path)

    for path in modified:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
