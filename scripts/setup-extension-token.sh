#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

service="whole-foods-cart.playwright-extension"
account="${USER:?USER is required}"

security add-generic-password \
  -U \
  -a "$account" \
  -s "$service" \
  -w

security find-generic-password \
  -a "$account" \
  -s "$service" \
  >/dev/null

printf 'Stored Playwright extension token in macOS Keychain for service %s.\n' "$service"
