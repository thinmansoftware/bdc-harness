#!/usr/bin/env bash
# Acknowledge or address xo mailbox rows with the live four-header lease binding.
# Token values are never printed. This script does not clear mail by any other verb.
set -euo pipefail

usage() {
  printf 'usage: xo-mailbox-ack.sh <ack|address> <message-id> [message-id...]\n' >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

verb="$1"
shift

if [[ "$verb" != "ack" && "$verb" != "address" ]]; then
  usage
  exit 2
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

ids=("$@")
for id in "${ids[@]}"; do
  if [[ ! "$id" =~ ^[A-Za-z0-9-]+$ ]]; then
    usage
    exit 2
  fi
done

if [[ -z "${BOARD_PRINCIPAL_TOKEN:-}" ]]; then
  printf 'BOARD_PRINCIPAL_TOKEN is required\n' >&2
  exit 2
fi

if [[ -z "${XO_HOLDER_TOKEN:-}" ]]; then
  printf 'XO_HOLDER_TOKEN is required\n' >&2
  exit 2
fi

base_url="${ARCHON_URL:-http://127.0.0.1:3090}"
base_url="${base_url%/}"

if [[ "${XO_ACK_DRY_RUN:-}" == "1" ]]; then
  for id in "${ids[@]}"; do
    printf 'POST %s/api/dispatch/messages/%s/%s x-board-principal-token x-xo-holder-token x-xo-lease-id x-xo-fencing-token body={}\n' \
      "$base_url" "$id" "$verb"
  done
  exit 0
fi

curl_common=()
if [[ -n "${ARCHON_OPERATOR_TOKEN:-}" ]]; then
  curl_common+=(-H "x-archon-operator-token: ${ARCHON_OPERATOR_TOKEN}")
fi

lease_body="$(mktemp)"
lease_err="$(mktemp)"
resp_body="$(mktemp)"
trap 'rm -f "$lease_body" "$lease_err" "$resp_body"' EXIT

lease_http=""
if ! lease_http="$(
  curl -sS \
    -o "$lease_body" \
    -w '%{http_code}' \
    --max-time 30 \
    "${curl_common[@]}" \
    "${base_url}/api/board/xo-lease/current" \
    2>"$lease_err"
)"; then
  printf 'lease_fetch_failed\n' >&2
  exit 1
fi

if [[ "$lease_http" != "200" ]]; then
  printf 'lease_fetch_failed\n' >&2
  exit 1
fi

parsed=""
py_status=0
set +e
parsed="$(
  python3 -c '
import json, re, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(4)
if data is None or not isinstance(data, dict) or "lease_id" not in data or data.get("lease_id") is None:
    sys.exit(3)
lease_id = data.get("lease_id")
fencing = data.get("fencing_token")
if not isinstance(lease_id, str) or re.fullmatch(r"[A-Za-z0-9-]+", lease_id) is None:
    sys.exit(5)
if isinstance(fencing, bool) or not isinstance(fencing, int) or fencing <= 0:
    sys.exit(5)
sys.stdout.write(lease_id + "\n" + str(fencing))
' "$lease_body" 2>/dev/null
)"
py_status=$?
set -e

if [[ "$py_status" -eq 3 ]]; then
  printf 'no_live_xo_lease\n' >&2
  exit 3
fi
if [[ "$py_status" -ne 0 ]]; then
  printf 'lease_fetch_failed\n' >&2
  exit 1
fi

lease_id="${parsed%%$'\n'*}"
fencing_token="${parsed#*$'\n'}"
if [[ ! "$lease_id" =~ ^[A-Za-z0-9-]+$ || ! "$fencing_token" =~ ^[0-9]+$ ]]; then
  printf 'lease_fetch_failed\n' >&2
  exit 1
fi

redact_detail() {
  local detail="$1"
  if [[ "$detail" == *"$BOARD_PRINCIPAL_TOKEN"* || "$detail" == *"$XO_HOLDER_TOKEN"* ]]; then
    printf 'error\n'
    return
  fi
  if [[ -n "${ARCHON_OPERATOR_TOKEN:-}" && "$detail" == *"$ARCHON_OPERATOR_TOKEN"* ]]; then
    printf 'error\n'
    return
  fi
  printf '%s\n' "$detail"
}

failed=0
for id in "${ids[@]}"; do
  http_status=""
  if ! http_status="$(
    curl -sS \
      -o "$resp_body" \
      -w '%{http_code}' \
      --max-time 30 \
      -X POST \
      -H 'content-type: application/json' \
      -H "x-board-principal-token: ${BOARD_PRINCIPAL_TOKEN}" \
      -H "x-xo-holder-token: ${XO_HOLDER_TOKEN}" \
      -H "x-xo-lease-id: ${lease_id}" \
      -H "x-xo-fencing-token: ${fencing_token}" \
      "${curl_common[@]}" \
      --data-raw '{}' \
      "${base_url}/api/dispatch/messages/${id}/${verb}" \
      2>/dev/null
  )"; then
    http_status="000"
  fi

  if [[ "$http_status" == "200" ]]; then
    printf '%s %s ok\n' "$id" "$http_status"
    continue
  fi

  detail="$(
    python3 -c '
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read()
    data = json.loads(raw) if raw.strip() else None
except Exception:
    print("error")
    raise SystemExit(0)
err = data.get("error") if isinstance(data, dict) else None
if isinstance(err, str) and err and "\n" not in err and "\r" not in err:
    print(err)
else:
    print("error")
' "$resp_body" 2>/dev/null || printf 'error\n'
  )"
  detail="$(redact_detail "$detail")"
  printf '%s %s %s\n' "$id" "$http_status" "$detail"
  failed=1
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
exit 0
