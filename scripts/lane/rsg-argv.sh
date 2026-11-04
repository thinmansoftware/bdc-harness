#!/usr/bin/env bash
# scripts/lane/rsg-argv.sh -- the ONE quote-aware tokenizer for the run-stop-greps node
# (rsg core) of every bdc-feature-development lane.
# WO-HARNESS-GREP-ALLOWLIST-QUOTED-MULTIWORD-01 (bdc-xo #4713, stage 1).
#
# SOURCED by the rsg core in each lane (never executed). Resolution order, same shape
# as scripts/lane/stop-tests-base.sh: $BDC_RSGARGV_SCRIPT (tests), then the engine's
# per-node copy $ARCHON_LANE_SCRIPTS_DIR/rsg-argv.sh, then the image copy
# /app/scripts/lane/rsg-argv.sh. When none exists the lane defines rsg_parse_pipeline
# as a function that returns 1, so every declared grep is dropped (fail closed).
#
# rsg_parse_pipeline <command>
#   Scans the command string ONCE, left to right. Returns 0 and fills the global array
#   RSG_PARSED (flat; one argv word per element; pipeline segments separated by the
#   single element equal to RSG_US, the one-character string ASCII 0x1F), or returns 1
#   and leaves RSG_PARSED empty.
#
#   Outside single quotes only these are accepted:
#     - the charset [A-Za-z0-9@%+=:,./_*?-]
#     - the standalone words [ and ]
#     - space and tab as word separators
#     - | as a segment separator (|| is rejected; an empty segment is rejected)
#   Everything else returns 1: ; & backtick $ ( ) > < newline double quote backslash and
#   any other byte (including every non-ASCII byte).
#
#   A single-quoted word must start at a word boundary and end at a word boundary (end
#   of string, space, tab or |); text glued to a quote on either side (a'b c', 'a b'c)
#   returns 1. An unterminated quote returns 1. An empty quoted word returns 1. Inside
#   single quotes any printable ASCII byte 0x20-0x7E is a literal EXCEPT the single
#   quote (it closes the word), the double quote and the backslash, which return 1.
#   A | inside single quotes is a literal, not a segment separator.
#
# The parse is the single source of truth: the lane's allowlist check
# (rsg_allow_cmd) and its execution (rsg_exec_pipeline) both consume RSG_PARSED, and
# execution is argv-only ("$@"), never a shell -c of the spec string, so a quoted
# pattern is never evaluated or glob-expanded. The bdc-xo validator CHECK 14 mirrors
# this rule (stage 2 of the WO) and is held to it by the shared verdict fixture
# .archon/workflows/defaults/__tests__/fixtures/grep-verdicts.tsv.
#
# ASCII only. Requires bash 4+ (arrays, ${var:offset:length}).

RSG_US=$'\037'
RSG_PARSED=()

rsg_parse_pipeline() {
  local LC_ALL=C
  local cmd="${1-}" n i j ch c2 nx lit word="" inword=0 segwords=0
  local -a out=()
  RSG_PARSED=()
  n=${#cmd}
  [ "$n" -gt 0 ] || return 1
  i=0
  while [ "$i" -lt "$n" ]; do
    ch="${cmd:i:1}"
    case "$ch" in
      "'")
        # a quote may only open at a word boundary (nothing glued before it)
        [ "$inword" -eq 0 ] || return 1
        j=$((i + 1))
        lit=""
        while :; do
          [ "$j" -lt "$n" ] || return 1
          c2="${cmd:j:1}"
          case "$c2" in
            "'") break ;;
            '"' | '\') return 1 ;;
            [[:print:]]) lit="$lit$c2" ;;
            *) return 1 ;;
          esac
          j=$((j + 1))
        done
        [ -n "$lit" ] || return 1
        # and must close at a word boundary (nothing glued after it)
        nx="${cmd:j+1:1}"
        case "$nx" in
          '' | ' ' | $'\t' | '|') ;;
          *) return 1 ;;
        esac
        out+=("$lit")
        segwords=$((segwords + 1))
        i=$((j + 1))
        ;;
      ' ' | $'\t')
        if [ "$inword" -eq 1 ]; then
          out+=("$word")
          segwords=$((segwords + 1))
          word=""
          inword=0
        fi
        i=$((i + 1))
        ;;
      '|')
        [ "${cmd:i+1:1}" != '|' ] || return 1
        if [ "$inword" -eq 1 ]; then
          out+=("$word")
          segwords=$((segwords + 1))
          word=""
          inword=0
        fi
        [ "$segwords" -gt 0 ] || return 1
        out+=("$RSG_US")
        segwords=0
        i=$((i + 1))
        ;;
      '[' | ']')
        # only as a standalone word (the test builtin): boundary on both sides
        [ "$inword" -eq 0 ] || return 1
        nx="${cmd:i+1:1}"
        case "$nx" in
          '' | ' ' | $'\t' | '|') ;;
          *) return 1 ;;
        esac
        out+=("$ch")
        segwords=$((segwords + 1))
        i=$((i + 1))
        ;;
      [A-Za-z0-9@%+=:,./_*?-])
        word="$word$ch"
        inword=1
        i=$((i + 1))
        ;;
      *) return 1 ;;
    esac
  done
  if [ "$inword" -eq 1 ]; then
    out+=("$word")
    segwords=$((segwords + 1))
  fi
  [ "$segwords" -gt 0 ] || return 1
  RSG_PARSED=("${out[@]}")
  return 0
}
