#!/usr/bin/env bash
# Builds the launch film end to end. Uses ElevenLabs voices and effects when a key is set
# (ELEVENLABS_API_KEY or launch/.env.local), macOS `say` and synthesized effects otherwise.
# Usage: bash launch/build.sh   ->  launch/out/cutroom-launch.mp4
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="${CUTROOM_LAUNCH_WORK:-$(mktemp -d)}"
export CUTROOM_HOME="$WORK/home"
mkdir -p launch/out "$CUTROOM_HOME"

npm run build >/dev/null
if [ -n "${ELEVENLABS_API_KEY:-}" ] || grep -qs ELEVENLABS_API_KEY launch/.env.local; then
  npx tsx launch/eleven.mts
fi
npx tsx launch/speaker.mts
rm -rf "$WORK/demo"
node dist/cli.js init "$WORK/demo" launch/out/speaker.webm --name launch-video >/dev/null
node dist/cli.js edit --project "$WORK/demo" '[{"op":"set_settings","aspect":"9:16"}]' >/dev/null
npx tsx launch/capture.mts "$WORK/demo"
(cd "$WORK/demo" && node "$OLDPWD/dist/cli.js" export --quality high --out "$OLDPWD/launch/out/after.mp4" >/dev/null)
rm -rf launch/out/before launch/out/after
npx tsx launch/film.mts --cues
npx tsx launch/music.mts
npx tsx launch/film.mts
ffmpeg -v error -y -i launch/out/film-video.mp4 -i launch/out/soundtrack.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart launch/out/cutroom-launch.mp4
echo "launch/out/cutroom-launch.mp4"
