#!/bin/sh
# Renders marketing/carousels.html → marketing/out/<name>.png (3600×1000) and <name>-{1,2,3}.png (1200×1000 cards).
cd "$(dirname "$0")" && mkdir -p out
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot(){ "$CHROME" --headless=new --disable-gpu --allow-file-access-from-files --hide-scrollbars --force-device-scale-factor=1 --window-size=$1 --virtual-time-budget=8000 --screenshot="$2" "file://$PWD/carousels.html?$3" >/dev/null 2>&1; }
i=1; for n in context-window self-healing model-picker dynamic-plan; do
  shot 3600,1000 out/$n.png only=$i
  for c in 1 2 3; do shot 1200,1000 out/$n-$c.png "only=$i&card=$c"; done
  i=$((i+1))
done; ls out
