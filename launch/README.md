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

## Rough Cut

`launch/rough/` makes "Rough Cut", the launch film that edits itself while you watch. It opens on its own stammering rough cut. A narrator leaves notes ("We're not editing it. We're leaving notes."), and Claude makes every edit over MCP: it cuts the false start, reframes the take into a 9:16 Short, then grades and captions it. After the review, a fast tour shows the editor's other tools on the same take, and the end card's waiting dot is cut into the cutroom mark. Every picture state is a real cutroom export or screen capture of the editor, and Reed's own sound plays whenever the film inside the film plays.

```bash
bash launch/rough/prep-footage.sh take.mp4 <project-dir>   # flatten, upscale, make the project
npx tsx launch/rough/capture-rough.mts <project-dir>        # drive the editor; Claude edits over MCP
npx tsx launch/rough/capture-tour.mts                       # the tour: the editor's other tools, captured
npx tsx launch/rough/states.mts                             # export each state of the film
npx tsx launch/rough/vo.mts --take=a                        # the narrator (ELEVENLABS_API_KEY)
npx tsx launch/rough/rough.mts --cues                       # the timeline, its holds sized to the reads
npx tsx launch/rough/beat.mts --style=a                     # the beat, composed to that timeline
npx tsx launch/rough/music-rough.mts --sfx-only             # the UI foley
npx tsx launch/rough/rough.mts                              # the picture
npx tsx launch/rough/mix.mts --take=a                       # mix, master to -14 LUFS, mux
```

| File | Does |
|---|---|
| `rough/vo.mts` | The narrator's lines through ElevenLabs, with word timings; `--take=a` (Charlie) or `b` (Laura) |
| `rough/capture-tour.mts` | Records the tour on a copy of the project: ⌘K, fillers, pauses, a zoom, caption templates, looks, a hook, studio sound, b-roll and PiP, a voice note, export aspects |
| `rough/rough.mts` | The compositor: cold open, the three notes, the pull-back, the review, the tour, the end card and the exit; writes `cues.json` |
| `rough/beat.mts` | ElevenLabs Music in two halves that meet at the film's stillness, so the drop lands on the bloom; `--style=a` (hybrid trap) or `b` (electro house) |
| `rough/mix.mts` | Narrator, Reed's sync sound, foley, designed hits and the beat, ducked under speech and mastered |
| `rough/music-rough.mts` | The original felt-piano score, and `--sfx-only` for the UI foley |
