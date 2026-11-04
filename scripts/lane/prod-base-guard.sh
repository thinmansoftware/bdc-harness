# scripts/lane/prod-base-guard.sh -- production-base guard for spec-declared PR bases.
#
# SOURCED (not executed) by the open-PR bash node of every bdc-feature-development
# lane that honours `base_branch_override` (a spec's `Base branch:` line). The image
# ships it at /app/scripts/lane/prod-base-guard.sh (Dockerfile: COPY scripts/lane/);
# the bundle generator embeds it for standalone and source runs.
#
# Why: plan-review treats a spec-declared base as self-authorizing (Rule 20 item 4).
# A self-authorizing base must never be a PRODUCTION base. Production changes go only
# through a carried board motion (Rule 20 / Motion M-09), never through a builder PR
# opened because a spec asked for it. WO-HARNESS-PLAN-REVIEW-STALE-STAGING-RULE-01
# (bdc-xo #4469), acting XO 2026-11-04.
#
# THIS IS THE ONLY LIST. Add or remove a refused pair here and nowhere else.
#
# Not listed on purpose: thinmansoftware/lspro-react release/ce. Opening a PR to it
# is the designed CE promotion path; M-09 gates it at merge (ALLOW_PROD_BASE in
# merge-if-approved). ASCII only.

BDC_PRODUCTION_BASES='thinmansoftware/shopops master
thinmansoftware/lspro-react main
thinmansoftware/shopops-storefront main'

# bdc_refuse_production_base <owner/repo> <base>
# Returns 1 and prints production_base_refused to stderr when the pair is listed,
# 0 otherwise. Comparison is exact (case-sensitive, as GitHub refs are).
bdc_refuse_production_base() {
  local repo="$1"
  local base="$2"
  local entry
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ "$entry" = "${repo} ${base}" ]; then
      echo "ERROR: production_base_refused: ${repo} ${base} is a production base. A spec-declared base never authorizes a PR to production; production changes need a carried board motion (Rule 20 / Motion M-09)." >&2
      return 1
    fi
  done <<EOF
${BDC_PRODUCTION_BASES}
EOF
  return 0
}
