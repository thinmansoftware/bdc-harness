#!/usr/bin/env bash
set -euo pipefail

usage() { echo "usage: send.sh API_BASE TOKEN_FILE SENDER RECIPIENT TASK_TYPE IDEMPOTENCY_KEY CORRELATION_ID PRIORITY BODY_FILE SUBJECT_KEY [REPEAT_REASON]" >&2; exit 2; }
[ "$#" -ge 10 ] || usage
api_base=${1%/}; token_file=$2; sender=$3; recipient=$4; task_type=$5
idempotency_key=$6; correlation_id=$7; priority=$8; body_file=$9; subject_key=${10}; repeat_reason=${11:-}
[[ "$subject_key" =~ ^wo:WO-[A-Z0-9]+(-[A-Z0-9]+)*$|^gh:[A-Za-z0-9][A-Za-z0-9.-]*/[A-Za-z0-9_.-]+#[1-9][0-9]*$ ]] || { echo "invalid subject_key" >&2; exit 2; }
token=$(tr -d '\r\n' < "$token_file"); [ -n "$token" ] || { echo "empty token file" >&2; exit 2; }
history=$(curl --fail --silent --show-error -H "authorization: Bearer $token" "$api_base/api/dispatch/messages?subject_key=$(printf %s "$subject_key" | jq -sRr @uri)&limit=100")
echo "$history" | jq -r '.[] | [.id,.status,(.task_outcome//"unknown"),(.acknowledged_at//"-"),(.addressed_at//"-"),(.repeat_reason//"-")] | @tsv' >&2
repeat=$(echo "$history" | jq 'any(.[]; .status=="done" or .status=="failed" or .task_outcome=="blocked" or .acknowledged_at!=null or .addressed_at!=null)')
[ "$repeat" != true ] || [ -n "$repeat_reason" ] || { echo "repeat reason required" >&2; exit 3; }
payload=$(jq -n --arg correlation_id "$correlation_id" --arg idempotency_key "$idempotency_key" --arg task_type "$task_type" --arg sender "$sender" --arg recipient "$recipient" --rawfile body "$body_file" --arg priority "$priority" --arg subject_key "$subject_key" --arg repeat_reason "$repeat_reason" '{correlation_id,idempotency_key,task_type,sender,recipient,body,priority,subject_key}+if $repeat_reason=="" then {} else {repeat_reason:$repeat_reason} end')
receipt=$(curl --fail --silent --show-error -H "authorization: Bearer $token" -H 'content-type: application/json' --data "$payload" "$api_base/api/dispatch/messages")
id=$(echo "$receipt" | jq -er '.id | select(type=="string" and length>0)')
status=$(echo "$receipt" | jq -er '.status'); returned_subject=$(echo "$receipt" | jq -er '.subject_key')
printf 'DISPATCH_RECEIPT id=%s subject_key=%s status=%s repeat=%s\n' "$id" "$returned_subject" "$status" "$repeat"
