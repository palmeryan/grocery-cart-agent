#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: ./scripts/build-wfm-cart.sh <grocery-list.json>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$repo_root/node_modules/.bin/tsx" \
  "$repo_root/src/cli.ts" build "$1"
