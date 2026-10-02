# Launch film

Scripts that make the ~43-second cutroom launch video from the real editor. A scripted user boxes a cut-off speaker, selects a filler word and asks for captions with ⌘K, while a real MCP client (standing in for Claude) picks up each note and makes the edit. No voiceover: picture, type, a piano score and quiet sound design. [BLUEPRINT.md](BLUEPRINT.md) has the editing rules, measured with [dissect](https://github.com/0xpratzyy/dissect).

```bash
bash launch/build.sh                      # footage generated with the Grok CLI
FOOTAGE=my-take.mp4 bash launch/build.sh  # or bring your own talking-head clip
```

| File | Does |
|---|---|
| `footage-brief.txt` | The Grok brief for the demo talking head (photoreal still → 10 s clip with speech) |
| `capture.mts` | Drives the editor in headless Chromium and records it, with Claude editing over MCP |
| `premium.mts` | Title scenes: the problem, the prompt, "What if you could just point?", the punchline, the end card |
| `film.mts` | Composites the title scenes, the captured editor (camera moves, crossfades, close-ups) and the before/after; writes sound cues |
| `music.mts` | 100 BPM piano score plus effects, mastered to −14 LUFS |
| `eleven.mts` | Optional ElevenLabs sound effects (`ELEVENLABS_API_KEY` in the environment or `launch/.env.local`) |

Needs macOS (SF fonts), ffmpeg, a transcription backend (`cutroom doctor`) and, for generated footage, the Grok CLI.
