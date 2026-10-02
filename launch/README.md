# Launch film

Scripts that produce the 35-second cutroom launch video from the real editor.

```bash
npm run build
npx tsx launch/speaker.mts                       # demo talking head (TTS + illustrated presenter)
CUTROOM_HOME=/tmp/cr-home node dist/cli.js init /tmp/cr-demo launch/out/speaker.webm
CUTROOM_HOME=/tmp/cr-home node dist/cli.js edit --project /tmp/cr-demo '[{"op":"set_settings","aspect":"9:16"}]'
CUTROOM_HOME=/tmp/cr-home npx tsx launch/capture.mts /tmp/cr-demo   # scripted user + MCP agent, screencast
(cd /tmp/cr-demo && CUTROOM_HOME=/tmp/cr-home node "$OLDPWD/dist/cli.js" export --quality high --out "$OLDPWD/launch/out/after.mp4")
npx tsx launch/film.mts --cues && npx tsx launch/music.mts && npx tsx launch/film.mts
ffmpeg -i launch/out/film-video.mp4 -i launch/out/soundtrack.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest launch/out/cutroom-launch.mp4
```

Needs macOS (`say`, SF fonts), ffmpeg and a transcription backend (`cutroom doctor`).
