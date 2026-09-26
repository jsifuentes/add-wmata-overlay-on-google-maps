#!/usr/bin/env bash
# Launches Firefox with the ./firefox profile and the extension installed as a
# temporary add-on (reloads on file changes). Remote debugging (WebDriver BiDi)
# listens on :9223.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx -y web-ext@latest run \
  --source-dir "$DIR/extension" \
  --firefox "${FIREFOX:-firefox}" \
  --firefox-profile "$DIR/firefox" --profile-create-if-missing --keep-profile-changes \
  --arg="--remote-debugging-port=9223" \
  ${1:+--start-url "$1"}
