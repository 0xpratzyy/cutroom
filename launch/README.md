# Launch film

Scripts that produce the 38-second cutroom launch video from the real editor: a scripted user annotates, comments and leaves a voice note while a real MCP client (standing in for Claude) fixes each note. [BLUEPRINT.md](BLUEPRINT.md) has the editing rules, measured with [dissect](https://github.com/0xpratzyy/dissect) against Raycast, Arc and Linear launch films.

```bash
bash launch/build.sh        # -> launch/out/cutroom-launch.mp4
```

| Script | Does |
|---|---|
| `eleven.mts` | ElevenLabs presenter voice, voice note and sound effects (needs `ELEVENLABS_API_KEY` in the environment or `launch/.env.local`) |
| `speaker.mts` | The demo talking head: an illustrated presenter lip-synced to the voice |
| `capture.mts` | Drives the editor in headless Chromium and records it, with Claude editing over MCP |
| `film.mts` | Composites beat cards, camera moves and macro close-ups, the before/after and the end card; writes sound cues |
| `motion.mts` | Kinetic scenes: the prompt-box gag, the pin with spring physics, the montage, the 3D type ring, the punchline, the end card |
| `music.mts` | 120 BPM synthesized score plus dialogue and effects, ducked and mastered to −12 LUFS |

Needs macOS (`say` fallback, SF fonts), ffmpeg and a transcription backend (`cutroom doctor`). Without an ElevenLabs key it falls back to `say` and synthesized effects.
