#!/usr/bin/env bash
# Packages extension/ into dist/wmata-overlay-firefox-<version>.zip for upload to
# addons.mozilla.org. Only git-tracked files are included, Chrome-only manifest
# keys are stripped, and the result is checked with `web-ext lint`.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

for cmd in jq zip git npx; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is required" >&2; exit 1; }
done

VERSION="$(jq -r .version extension/manifest.json)"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]] || { echo "error: invalid manifest version '$VERSION'" >&2; exit 1; }

if [[ -n "$(git status --porcelain -- extension)" ]]; then
  echo "warning: extension/ has uncommitted changes; they will be included" >&2
fi

OUT="$DIR/dist/wmata-overlay-firefox-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git ls-files -z -- extension | while IFS= read -r -d '' f; do
  [[ -e "$f" ]] || continue  # tracked but deleted in the working tree
  mkdir -p "$STAGE/$(dirname "${f#extension/}")"
  cp "$f" "$STAGE/${f#extension/}"
done

# Firefox uses background.scripts; background.service_worker is Chrome-only.
jq 'del(.background.service_worker)' extension/manifest.json > "$STAGE/manifest.json"

npx -y web-ext@latest lint --source-dir "$STAGE" --warnings-as-errors=false

mkdir -p "$DIR/dist"
rm -f "$OUT"
(cd "$STAGE" && zip -qrX9 "$OUT" .)

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
