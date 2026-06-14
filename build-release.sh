#!/usr/bin/env bash
# Builds a store-ready zip in ./dist/ for both the Chrome Web Store and
# Firefox Add-ons (AMO). The same artifact works for both:
#   - The CWS REJECTS a manifest containing a "key" field (the store assigns
#     the published ID itself), so we strip it from the staged copy.
#   - AMO ignores "key" but flags it as a lint warning, so stripping it is
#     also the clean choice for Firefox. Firefox identity comes from
#     browser_specific_settings.gecko.id, which stays in the manifest.
# The repo manifest keeps "key" so unpacked dev installs hold a stable ID.
#
# This is the macOS/Linux twin of build-release.ps1 (identical output).
#
# Usage:  ./build-release.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
staging="$repo/dist/staging"
dist="$repo/dist"

rm -rf "$staging"
mkdir -p "$staging"

# Everything the extension actually loads at runtime, plus the GPL license.
files=(
  manifest.json LICENSE
  background.js shared.js content.js early.js welcome.js
  options.js popup.js
  options.html popup.html welcome.html
  preload.css features.css home.css
)
for f in "${files[@]}"; do cp "$repo/$f" "$staging/"; done
cp -R "$repo/icons" "$staging/icons"
cp -R "$repo/pictures" "$staging/pictures"

# Strip the "key" field from the staged manifest (whole line, incl. trailing
# comma). It's not the last property, so removing the line keeps valid JSON.
manifest="$staging/manifest.json"
grep -v '^[[:space:]]*"key":[[:space:]]*"' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

# Sanity: staged manifest must not contain "key" and must still parse if a
# JSON tool is available (python3 is on macOS by default).
if grep -q '"key"' "$manifest"; then echo "ERROR: key field survived the strip" >&2; exit 1; fi
if command -v python3 >/dev/null 2>&1; then
  version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")
else
  version=$(grep -oE '"version":[[:space:]]*"[^"]+"' "$manifest" | grep -oE '[0-9][^"]*')
fi

zip_path="$dist/betterfeed-$version.zip"
rm -f "$zip_path"
( cd "$staging" && zip -r -q "$zip_path" . )

rm -rf "$staging"
echo "Built $zip_path"
