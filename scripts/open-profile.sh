#!/usr/bin/env bash
set -euo pipefail

profile_dir="${WFM_CHROME_PROFILE_DIR:-$HOME/.whole-foods-cart/chrome-profile}"
mkdir -p "$profile_dir"
chmod 700 "$profile_dir"

cat <<EOF
Opening the dedicated Whole Foods cart profile.
1. Sign in to the Whole Foods Market account used for grocery delivery.
2. Set the delivery address used for Whole Foods inventory.
3. Open the Whole Foods storefront once.
4. Close every window using this profile before running a cart job.
Profile: $profile_dir
EOF

open -na "Google Chrome" --args \
  "--user-data-dir=$profile_dir" \
  "https://www.wholefoodsmarket.com/grocery/search"
