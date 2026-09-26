#!/usr/bin/env bash
# Launches Chrome for Testing with the ./chrome profile, the unpacked extension
# loaded, and remote debugging on :9222 (used by the chrome-devtools MCP server).
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-$(ls -d "$HOME"/.cache/chrome-for-testing/chrome/linux-*/chrome-linux64/chrome | sort -V | tail -1)}"
exec "$CHROME" \
  --user-data-dir="$DIR/chrome" \
  --remote-debugging-port=9222 \
  --load-extension="$DIR/extension" \
  --no-first-run --no-default-browser-check \
  "$@"
