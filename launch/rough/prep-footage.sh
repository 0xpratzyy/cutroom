#!/usr/bin/env bash
# Prepares Rough Cut's footage and project from the Grok take:
#   flatten (a log-ish look Claude's grade can bloom out of) + upscale to 1080p -> take-flat.mp4,
#   a VP9/Opus copy for the editor (headless Chromium has no H.264) -> take-flat.webm,
#   then a 16:9 1920x1080 cutroom project made from the webm, and its transcript.
# Usage: bash launch/rough/prep-footage.sh <take.mp4> [project-dir]
#   project-dir defaults to $CUTROOM_LAUNCH_WORK/film (a temp dir if unset); next step:
#   npx tsx launch/rough/capture-rough.mts <project-dir>
set -euo pipefail
[ -f "${1:-}" ] || { echo "usage: bash launch/rough/prep-footage.sh <take.mp4> [project-dir]" >&2; exit 1; }
TAKE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
# A relative project dir is relative to where the script was run from, not the repo root.
case "${2:-}" in "") DIR="" ;; /*) DIR="$2" ;; *) DIR="$PWD/$2" ;; esac
cd "$(dirname "$0")/../.."
WORK="${CUTROOM_LAUNCH_WORK:-$(mktemp -d)}"
DIR="${DIR:-$WORK/film}"
OUT=launch/out/rough
export CUTROOM_HOME="$WORK/home"
# Step 2 only ever replaces a cutroom project (or an empty / missing dir): the path comes from the command line.
if [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && [ ! -f "$DIR/cutroom.json" ]; then
  echo "refusing to replace $DIR: not a cutroom project" >&2
  exit 1
fi
mkdir -p "$OUT" "$CUTROOM_HOME"
[ -f dist/cli.js ] || npm run build >/dev/null

# 1. Flatten + upscale. The look is lifted blacks, rolled-off whites, less saturation, a faint green-blue cast.
ffmpeg -v error -y -i "$TAKE" -map "0:V:0" -map "0:a:0?" \
  -vf "scale=1920:1080:flags=lanczos,unsharp=5:5:0.5,curves=all='0/0.07 1/0.93',eq=saturation=0.72:gamma=1.04,colorbalance=gs=0.03:bs=0.02" \
  -c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p -c:a copy -movflags +faststart "$OUT/take-flat.mp4"
# The webm is also what every state is exported from, so keep it near-lossless.
ffmpeg -v error -y -i "$OUT/take-flat.mp4" -c:v libvpx-vp9 -crf 14 -b:v 0 -deadline good -cpu-used 2 -row-mt 1 -c:a libopus -b:a 160k "$OUT/take-flat.webm"

# 2. The project, analysed with a model that keeps filler words (the stammer is the first cut).
rm -rf "$DIR"
node dist/cli.js init "$DIR" "$OUT/take-flat.webm" --name launch-film --model small.en >/dev/null
node dist/cli.js edit --project "$DIR" '[{"op":"set_settings","aspect":"16:9","width":1920,"height":1080}]' >/dev/null

# 3. The transcript, with word indices: check 'is it— is it rolling? okay. umm.' starts at 0.
#    Whisper's 'Cut Room.' becomes one word 'cutroom.' and 'Cloud'/'Clod' becomes 'Claude' (indices
#    are renumbered; nothing refers to them yet). Anything else it mishears: patch the file by hand.
node -e '
const fs = require("fs");
const f = process.argv[1];
const t = JSON.parse(fs.readFileSync(f, "utf8"));
const bare = (w) => w.toLowerCase().replace(/[^a-z]/g, "");
const tail = (w) => w.match(/[^A-Za-z]*$/)[0];
const words = [];
let fixed = 0;
for (let i = 0; i < t.words.length; i++) {
  const w = { ...t.words[i] }, next = t.words[i + 1];
  if (bare(w.text) === "cut" && next && bare(next.text) === "room") {
    Object.assign(w, { text: `cutroom${tail(next.text)}`, end: next.end, conf: Math.min(w.conf ?? 1, next.conf ?? 1) });
    i++, fixed++;
  } else if (/^(cloud|clod|claud|clawed)$/.test(bare(w.text))) (w.text = `Claude${tail(w.text)}`), fixed++;
  words.push({ ...w, i: words.length });
}
if (fixed) fs.writeFileSync(f, JSON.stringify({ ...t, words }, null, 2));
console.log(words.map((w) => `${w.i}:${w.text} ${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join("\n"));
if (fixed) console.log(`(patched ${fixed} word${fixed > 1 ? "s" : ""})`);
' "$DIR/.cutroom/cache/m1/transcript.json"
echo
echo "Project: $DIR"
echo "Next:    npx tsx launch/rough/capture-rough.mts \"$DIR\""
