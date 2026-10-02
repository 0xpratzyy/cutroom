#!/usr/bin/env bash
# Generates synthetic test media: a "talking head" (test pattern + speech with pauses
# and filler words) and a silent b-roll clip. Speech uses macOS `say`, or espeak-ng elsewhere.
set -euo pipefail
mkdir -p "$(dirname "$0")/../test/fixtures"
cd "$(dirname "$0")/../test/fixtures"
TEXT="Hey everyone, welcome back to the channel. [[slnc 1400]] Um, today I want to talk about, uh, how to edit videos with an AI agent. [[slnc 1800]] So the idea is pretty simple. [[slnc 900]] You record yourself talking, and the agent cuts out the silences, um, removes the filler words, and adds captions. [[slnc 1500]] Uh, let's get into it."
if command -v say >/dev/null; then
  say -v Samantha -o speech.aiff "$TEXT"
  SPEECH=speech.aiff
else
  espeak-ng -w speech.wav "$(echo "$TEXT" | sed 's/\[\[slnc [0-9]*\]\]/... .../g')"
  SPEECH=speech.wav
fi
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SPEECH")
ffmpeg -y -v error -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=$D" -i "$SPEECH" -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -shortest talking.mp4
ffmpeg -y -v error -f lavfi -i "mandelbrot=size=1280x720:rate=30" -t 6 -c:v libx264 -pix_fmt yuv420p -preset veryfast broll.mp4
rm -f "$SPEECH"
echo "Wrote test/fixtures/talking.mp4 and broll.mp4"
