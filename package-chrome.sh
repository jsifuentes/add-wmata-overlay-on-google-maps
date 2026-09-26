#!/usr/bin/env bash
# Packages extension/ into dist/wmata-overlay-chrome-<version>.zip for upload to
# the Chrome Web Store. Only git-tracked files are included, and Firefox-only
# manifest keys are stripped so the store doesn't flag them.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

for cmd in jq zip git; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is required" >&2; exit 1; }
done

VERSION="$(jq -r .version extension/manifest.json)"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]] || { echo "error: invalid manifest version '$VERSION'" >&2; exit 1; }

DESC_LEN="$(jq -r '.description | length' extension/manifest.json)"
(( DESC_LEN <= 132 )) || { echo "error: manifest description is $DESC_LEN chars; Chrome Web Store max is 132" >&2; exit 1; }

if [[ -n "$(git status --porcelain -- extension)" ]]; then
  echo "warning: extension/ has uncommitted changes; they will be included" >&2
fi

OUT="$DIR/dist/wmata-overlay-chrome-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git ls-files -z -- extension | while IFS= read -r -d '' f; do
  [[ -e "$f" ]] || continue  # tracked but deleted in the working tree
  mkdir -p "$STAGE/$(dirname "${f#extension/}")"
  cp "$f" "$STAGE/${f#extension/}"
done

# Chrome uses background.service_worker; background.scripts and
# browser_specific_settings are Firefox-only.
jq 'del(.background.scripts, .browser_specific_settings)' extension/manifest.json > "$STAGE/manifest.json"

mkdir -p "$DIR/dist"
rm -f "$OUT"
(cd "$STAGE" && zip -qrX9 "$OUT" .)

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
