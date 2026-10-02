#!/usr/bin/env bash
# Builds the launch film end to end:
#   footage (FOOTAGE=<file>, or generated with the Grok CLI from launch/footage-brief.txt)
#   -> a cutroom project -> the editor captured while Claude edits over MCP -> the real export
#   -> the composited film + score.
# Usage: bash launch/build.sh   ->  launch/out/cutroom-launch.mp4
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="${CUTROOM_LAUNCH_WORK:-$(mktemp -d)}"
export CUTROOM_HOME="$WORK/home"
mkdir -p launch/out "$CUTROOM_HOME"
npm run build >/dev/null

# 1. Footage: a talking head sitting off-centre, with a filler word to cut.
if [ -n "${FOOTAGE:-}" ]; then
  cp "$FOOTAGE" launch/out/footage.mp4
elif [ ! -f launch/out/footage.mp4 ]; then
  mkdir -p "$WORK/grok"
  (cd "$WORK/grok" && grok --permission-mode bypassPermissions --prompt-file "$ROOT/launch/footage-brief.txt")
  cp "$WORK/grok/speaker.mp4" launch/out/footage.mp4
fi
# Headless Chromium has no H.264, so the editor gets VP9.
ffmpeg -v error -y -i launch/out/footage.mp4 -c:v libvpx-vp9 -b:v 6M -deadline good -cpu-used 4 -row-mt 1 -c:a libopus -b:a 160k launch/out/footage.webm

# 2. The project, analysed with a model that keeps filler words.
rm -rf "$WORK/demo"
node dist/cli.js init "$WORK/demo" launch/out/footage.webm --name launch-video --model small.en >/dev/null
node dist/cli.js edit --project "$WORK/demo" '[{"op":"set_settings","aspect":"9:16"}]' >/dev/null

# 3. The editor, captured while Claude edits over MCP; then the real export.
FOCUS_X="${FOCUS_X:-0.29}" npx tsx launch/capture.mts "$WORK/demo"
(cd "$WORK/demo" && node "$ROOT/dist/cli.js" export --quality high --out "$ROOT/launch/out/after.mp4" >/dev/null)

# 4. The film and its score (ElevenLabs effects if launch/eleven.mts has run).
rm -rf launch/out/before launch/out/after
npx tsx launch/film.mts --cues
npx tsx launch/music.mts
npx tsx launch/film.mts
ffmpeg -v error -y -i launch/out/film-video.mp4 -i launch/out/soundtrack.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart launch/out/cutroom-launch.mp4
echo "launch/out/cutroom-launch.mp4"
