# cutroom

**An open-source, local-first video editor that AI agents can actually use.** Point at what's wrong in the video and Claude fixes it.

cutroom is built for talking-head videos (YouTube, shorts, tutorials, podcasts). Edit by text in a full web editor, or hand the job to an agent over [MCP](https://modelcontextprotocol.io). Agents can *perceive* the footage through word-level transcripts and contact sheets, edit with validated operations, and check their own work with real rendered previews. Meanwhile you watch every change land live in the editor.

Everything runs on your machine: ffmpeg for rendering, Whisper for transcription. No cloud and no API keys.

```
"Edit ~/rec/take3.mp4 into a vertical short: cut the ums and dead air,
 drop the false start, punch in on the key line, add captions."
```

## Point at it, Claude fixes it

Like [Agentation](https://benji.org/agentation), but for video. In the editor:

- Press **A** and click the frame to pin a note, or drag to mark an area: *"the speaker is cut off here"*.
- Select transcript words, a timeline range or a clip and press **C**: *"cut this ramble"*, *"this cut is abrupt"*.

Each note gets a numbered marker on the frame, the scrubber, the timeline ruler and the transcript. A connected agent receives notes over MCP as structured markdown **plus the rendered frame with your marker drawn on it**. It marks each one *working*, makes the edit, checks it with a preview, then resolves it with a reply. You watch it happen live. With `wait_for_feedback` it stays in the loop: keep leaving notes, and it keeps fixing them.

**Voice notes:** hold **V** (or the Talk button) and just say it while the video plays: *"cut this, it drags"*. It's transcribed locally and pinned to that moment, with the words on screen and a frame pin wherever your cursor was.

No MCP? **Copy** puts the notes on your clipboard as markdown for any agent.

## Review the agent's edits like a pull request

When Claude edits, cutroom keeps the version from before its first change. A bar over the video shows how many changes it made, with a **Before / After** toggle that flips the preview between the two versions. Footage it cut shows up red in the transcript and on a **Changes** lane in the timeline; footage it brought back shows green; zooms, b-roll and style changes are listed too. Revert any single change, **Keep all**, or **Reject all**.

## Features

- **Text-based editing.** Select words in the transcript and press Delete. Cut words stay visible (struck through) and can be restored.
- **Retake detection.** Restarted lines ("so today I want to… so today I want to show you") are grouped as takes with the best one suggested. Keep it in one click, or let Claude pick (`find_retakes`).
- **Command palette (⌘K).** Every action by name, and anything else you type goes to Claude as a note: "make the intro punchier".
- **Smooth zooms and jump-cut hiding.** Punch-ins or eased push-ins (identical in preview and export), plus one action that alternates framing at every cut.
- **One-click cleanup.** Remove filler words (um, uh, …) and tighten pauses with configurable thresholds.
- **Live preview without rendering.** The browser player follows cuts, zooms, b-roll and captions in real time, using the same math as the exporter.
- **Reframe 16:9 → 9:16 / 1:1 / 4:5** with a per-clip focal point.
- **Punch-in zooms, b-roll and picture-in-picture.**
- **Looks / LUTs:** 8 built-in grades tuned for talking heads (Clean, Warm, Teal & Orange, Moody, Film, Vivid, Bleach, B&W), your own `.cube` files, intensity, and exposure/contrast/saturation/temperature. Every look is baked into one LUT that both the WebGL preview and ffmpeg use, so preview matches export.
- **Caption Studio:** 8 animated templates (Pop, Karaoke, One word, Typewriter, Boxed, Underline, Neon, Subtitle), word animations (pop, bounce, fade, rise, reveal), active-word styles (color, box, scale, underline), emphasis words, glow, and **custom fonts** (drop in a `.ttf`/`.otf` or pick any installed font). Claude can pick the emphasis words for you.
- **Hook title:** a big animated title over the opening seconds (Highlight, Headline, Outline, Minimal), in your font and brand colors. Claude can write it from the transcript.
- **Brand kit:** logo, colors, font, caption template and look, saved once on your machine (`~/.cutroom/brand`). One click (or `apply_brand`) puts the logo watermark, colors and font on any project, as a single undoable edit.
- **Studio sound:** Clean, Podcast, Crisp and Broadcast presets (high-pass, FFT noise reduction, voice EQ, de-essing, compression, limiting) with a strength slider. The preview applies the EQ and compression live, with hold-to-compare; **Hear it** renders the final chain, noise reduction included, for the moment you're on.
- **Loudness normalization** (−16 LUFS) and click-free micro-fades at every cut.
- **Export** MP4, SRT captions, or an [OpenTimelineIO](https://opentimeline.io) timeline you can open in Resolve or Premiere.
- **Shared undo history** across you, agents and the CLI.

## Quick start

Requirements: Node 20+ and ffmpeg. For transcription, [uv](https://docs.astral.sh/uv/) is the easiest option (faster-whisper installs itself on first run). Run `npx cutroom doctor` to check your setup; it prints the exact fix command for your OS.

```bash
npx cutroom ~/Desktop/recording.mp4   # creates a project next to the video, transcribes it, opens the editor
npx cutroom                           # opens the project in the current folder (or starts one)
npx cutroom doctor                    # checks ffmpeg, filters, transcription, permissions
```

### Use it from an agent

**Claude Code**

```bash
claude mcp add cutroom -- npx -y cutroom mcp
```

**Claude Desktop / Cursor / any MCP client**

```json
{
  "mcpServers": {
    "cutroom": { "command": "npx", "args": ["-y", "cutroom", "mcp"] }
  }
}
```

Then ask: *"Use cutroom to edit ~/Desktop/recording.mp4 into a tight YouTube video and open the editor so I can watch."* Once it's open, leave notes on the video and ask: *"Work through my cutroom feedback, then keep watching for more."* The server ships `edit_talking_head` and `address_feedback` prompts for these workflows.

## MCP tools

The tool surface is deliberately small and coarse. Agents do better with a few powerful tools than with dozens of tiny ones.

| Tool | What it does |
| --- | --- |
| `create_project` / `open_project` | Create or open a project folder; import and analyze recordings |
| `import_media`, `analyze` | Add media (main track or library); (re)run transcription and silence detection |
| `get_timeline` | Compact summary: clips (timeline ↔ source), b-roll, zooms, captions, format |
| `get_transcript` | Word-level transcript with timeline times and stable word indices; cut words shown as `~12:word~` |
| `view_frames` | Labeled contact sheet of frames at timeline times (fast) |
| `preview` | Renders a draft of a range exactly as it will export and returns sampled frames |
| `get_selection` | What the user is pointing at in the editor (playhead, range, clips, words) |
| `get_feedback` | Notes pinned in the editor: time, frame region, words, clip, plus annotated frames |
| `wait_for_feedback` | Blocks until new notes arrive, so the agent can stay in an edit loop with you |
| `update_feedback` | Mark a note working or resolved and reply to it (shown live in the editor) |
| `edit` | Batch of validated operations applied atomically as one undo step |
| `undo` / `redo` | Shared history with the editor |
| `list_styles` | Built-in looks, custom LUTs, caption templates, fonts, brand kit, hook and sound presets |
| `apply_brand` | Apply the saved brand kit (logo, colors, font) to the project |
| `find_retakes` | Repeated attempts at the same line and the suggested best take; `apply` keeps the best ones |
| `export` | MP4 / SRT / OTIO |
| `open_editor` | Starts the web editor so the user can watch live |

### Edit operations

`cut`, `cut_source`, `remove_words`, `restore_words`, `remove_text`, `remove_silences`, `remove_fillers`, `split`, `add_clip`, `remove_clip`, `trim_clip`, `move_clip`, `set_focus`, `add_broll`, `update_overlay`, `remove_overlay`, `add_zoom`, `update_zoom`, `remove_zoom`, `set_captions` (incl. `preset`, `animation`, `emphasisWords`), `set_look`, `set_hook`, `set_watermark`, `set_audio`, `set_settings`, `restore_source`, `jump_cut_zoom`.

```json
{ "ops": [
  { "op": "remove_fillers" },
  { "op": "remove_silences", "minDuration": 0.6, "keep": 0.2 },
  { "op": "remove_text", "text": "so what I was trying to say is" },
  { "op": "set_settings", "aspect": "9:16" },
  { "op": "add_zoom", "start": 12.4, "end": 15.1, "scale": 1.3 },
  { "op": "set_captions", "enabled": true, "uppercase": true, "maxWords": 3 }
]}
```

Batches are all-or-nothing. Invalid input returns a precise error, such as `op #2 (add_zoom): overlaps zoom z4k2 (12.00-13.50)`, so the agent can correct itself.

## Editor

| Shortcut | |
| --- | --- |
| `Space` | Play / pause |
| `⌫` | Cut selected words / delete selected item / cut range |
| `S` | Split at playhead |
| `Z` | Punch-in zoom on selection or at playhead |
| `⌘K` | Command palette / ask Claude |
| `← →` | Frame step (`⇧` = 1s) |
| `A` | Annotate: click the frame to pin a note, drag to mark an area |
| `C` | Note about the selected words, range or clip (or this moment) |
| hold `V` | Voice note while you watch |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `+ −`, `⌘`+scroll | Timeline zoom |

Drag a video onto the window to import it. Drag items from the Media tab onto the Main or B-roll track. Drag empty timeline space to select a range.

## How it works

```
                 ┌──────────── cutroom.json (source of truth) ────────────┐
                 │  media · clips · overlays · zooms · captions · format  │
                 └──────▲──────────────────▲──────────────────▲───────────┘
                        │ edit ops         │ edit ops         │ edit ops
                 ┌──────┴──────┐    ┌──────┴──────┐    ┌──────┴──────┐
                 │ MCP server  │    │ Web editor  │    │     CLI     │
                 │ (any agent) │    │ (HTTP + WS) │    │             │
                 └──────┬──────┘    └──────┬──────┘    └─────────────┘
                        │                  │
          ┌─────────────┴──────────────────┴──────────────┐
          │ core: ops · render plan · captions · crop math │  ← shared by Node and the browser
          ├────────────────────────────────────────────────┤
          │ ffmpeg render · whisper transcribe · analysis   │
          └────────────────────────────────────────────────┘
```

- **One project file, many writers.** The MCP server, editor and CLI may run as separate processes. They share `cutroom.json` through a lock file and atomic writes, and the editor watches the folder, so agent edits appear live.
- **Ops, not raw JSON.** Every change goes through `applyOps()` (`src/core/shared/ops.ts`), which is pure, validated and atomic. Removing content ripples b-roll and zooms automatically.
- **One plan, two renderers.** `buildPlan()` flattens the project into pieces, overlays and caption pages. The browser previews it with two double-buffered `<video>` elements. The exporter compiles it into a single ffmpeg filter graph. Both use the same `computeCrop()` and `drawCaptionPage()`, so preview and export match.
- **No exotic ffmpeg build needed.** Captions are drawn with `@napi-rs/canvas` and composited as a PNG stream, so libass and freetype aren't required.

### Project layout

```
my-edit/
  cutroom.json        # the edit: human-readable, diffable
  media/              # files dropped into the editor
  fonts/  luts/       # your custom fonts and .cube LUTs
  exports/
  .cutroom/           # caches, undo history, selection, feedback notes, agent presence
```

### Transcription backends

Auto-detected in this order (force one with `CUTROOM_TRANSCRIBER`):

1. **whisper.cpp:** `whisper-cli` on PATH and `CUTROOM_WHISPER_CPP_MODEL=/path/to/ggml-base.en.bin`
2. **faster-whisper via uv:** installed automatically on first run
3. **faster-whisper in python3:** `pip install faster-whisper`

Choose the model with `--model` or `CUTROOM_WHISPER_MODEL` (default `base.en`; try `small.en` for accuracy or `small` for other languages). Whisper is primed to keep disfluencies so filler words actually show up in the transcript.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and releases.

```bash
npm install
npm run fixtures          # generate synthetic test videos (macOS `say` or espeak-ng)
npm run dev               # editor on :5173 with hot reload, API on :4321
CUTROOM_PROJECT=~/videos/x npm run dev
npm test                  # unit tests for the edit engine
npm run test:e2e          # Playwright tests that drive the editor
npx tsx --test test/integration/*.test.ts   # MCP end to end (needs fixtures + transcription)
npm run test:pack         # pack, install into a temp dir, smoke-test the CLI and MCP
npm run build
```

Source map:

| Path | |
| --- | --- |
| `src/core/shared/` | Browser-safe: schema, ops, timeline math, render plan, caption layout |
| `src/core/` | Node: project store, media analysis, transcription, ffmpeg renderer, contact sheets |
| `src/mcp/` | MCP server and op schemas |
| `src/server/` | HTTP + WebSocket server for the editor |
| `web/` | React editor (Vite) |

## Roadmap

- Smooth (animated) zooms and Ken Burns on stills
- Automatic speaker framing via face detection
- Retake detection: find repeated sentences and keep the best take
- Multi-cam and multi-speaker podcasts (speaker diarization)
- Music bed with auto-ducking
- Caption animation styles
- Transitions between clips

## Known limitations

- Preview playback seeks at cut boundaries. It's double-buffered, but very short clips (< 0.2s) may stutter in the browser. Exports are frame-accurate.
- The whisper.cpp backend has had less testing than faster-whisper.
- Tested against a synthetic corpus (rotated phone video, VFR, 4K HEVC 10-bit, noisy audio, 1-hour files, odd paths) and on macOS. Windows/Linux and real-world recordings need more mileage: please file issues with a sample.

## License

MIT
