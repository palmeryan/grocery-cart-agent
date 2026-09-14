#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

if [[ "$#" -ne 3 ]]; then
  printf 'usage: playwright-extension-mcp.sh <absolute-mcp-bin> <absolute-output-dir> <absolute-profile-dir>\n' >&2
  exit 64
fi

mcp_bin="$1"
output_dir="$2"
profile_dir="$3"
service="whole-foods-cart.playwright-extension"
account="${USER:?USER is required}"

if [[ "$mcp_bin" != /* || ! -x "$mcp_bin" ]]; then
  printf 'Playwright MCP binary must be an executable absolute path.\n' >&2
  exit 66
fi
if [[ "$output_dir" != /* || ! -d "$output_dir" ]]; then
  printf 'Browser output directory must be an existing absolute path.\n' >&2
  exit 66
fi
if [[ "$profile_dir" != /* || ! -d "$profile_dir" ]]; then
  printf 'Chrome profile directory must be an existing absolute path.\n' >&2
  exit 66
fi

token="$(security find-generic-password -a "$account" -s "$service" -w)"
if [[ -z "$token" ]]; then
  printf 'Playwright extension token is empty.\n' >&2
  exit 78
fi

PLAYWRIGHT_MCP_EXTENSION_TOKEN="$token" exec "$mcp_bin" \
  --extension \
  "--user-data-dir=$profile_dir" \
  "--output-dir=$output_dir" \
  --caps=devtools
