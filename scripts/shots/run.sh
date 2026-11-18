#!/bin/zsh
# Regenerate the instruction and README screenshots in public/help/ from the real app.
# Needs: Google Chrome, Node 22+, python3 with Pillow, and network for satellite tiles.
#   scripts/shots/run.sh
set -e
cd "$(dirname "$0")/../.."
SCR=$(mktemp -d)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL=http://localhost:4173/youAreHere/

npm run build >/dev/null
npx vite preview --port 4173 --strictPort >"$SCR/preview.log" 2>&1 &
PREVIEW=$!
cleanup() { kill $PREVIEW 2>/dev/null; pkill -f "remote-debugging-port=9333" 2>/dev/null; sleep 1; rm -rf "$SCR" 2>/dev/null || true; }
trap cleanup EXIT

chrome() {  # fresh profile each run, so nothing leaks between screenshot sets
  pkill -f "remote-debugging-port=9333" 2>/dev/null || true
  "$CHROME" --headless=new --disable-gpu --remote-debugging-port=9333 --user-data-dir="$SCR/profile-$1" about:blank >/dev/null 2>&1 &
  for i in {1..20}; do curl -s http://127.0.0.1:9333/json/version >/dev/null && return; sleep 0.5; done
}

chrome help && node scripts/shots/help-shots.mjs $URL "$SCR/shots" "$SCR"
chrome demo && node scripts/shots/demo-shots.mjs $URL "$SCR/shots"

for f in "$SCR"/shots/*.png; do
  sips -s format jpeg -s formatOptions 78 "$f" --out "public/help/$(basename "${f%.png}").jpg" >/dev/null
done
ls -la public/help
