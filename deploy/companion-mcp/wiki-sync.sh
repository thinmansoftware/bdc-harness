#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: wiki-sync.sh <checkout> <token-file>" >&2
  exit 2
fi

checkout=$1
token_file=$2

helper=$(mktemp)
chmod 700 "$helper"
trap 'rm -f "$helper"' EXIT

cat > "$helper" << 'EOF'
#!/bin/sh
set -eu
token=$(cat "${WIKI_SYNC_TOKEN_FILE:?}")
printf '%s\n' "$token"
EOF
chmod 700 "$helper"

export WIKI_SYNC_TOKEN_FILE="$token_file"
export GIT_ASKPASS="$helper"
export GIT_TERMINAL_PROMPT=0

git -C "$checkout" fetch origin
git -C "$checkout" reset --hard origin/main
