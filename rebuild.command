#!/bin/sh
set -e
cd "$(dirname "$0")"
osascript -e 'quit app "Emma"' 2>/dev/null || true
for _ in $(seq 1 15); do
  pgrep -x Emma >/dev/null || break
  sleep 1
done
pkill -x Emma || true
pkill -x emma-cli || true
EMMA_FAST_BUILD=1 npm run package:mac
open -a "$PWD/desktop/release/Emma-darwin-arm64/Emma.app"
