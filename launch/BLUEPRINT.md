# Launch film blueprint (from dissect)

Measured with [dissect](https://github.com/0xpratzyy/dissect) on 2026-10-02: our v1 cut against three short product launch films.

| | cutroom v1 | Raycast "New Raycast" (39 s) | Arc 1.0 (34 s) | Linear Agent (55 s) |
|---|---|---|---|---|
| Cuts / min | 6.9 | 9.3 | 31.5 | 0 (one continuous shot) |
| Picture changes / min | 27.4 | 18.7 | 31.5 | 17.5 |
| Mean / median shot | 7.0 s / 4.0 s | 5.5 s / 5.1 s | 1.8 s / 1.4 s | 55 s |
| First picture change | 1.05 s | 0.95 s | 5.1 s (slow-burn cold open) | 3.0 s |
| Loudness / true peak | −10.1 LUFS / **+1.0 dBFS** | −13.2 / 0.0 | −11.5 / +0.1 | −28.9 / −5.0 |
| Bed under dialogue | **−2.9 dB** | (no VO) | (no VO) | (no VO) |
| Music | 120 BPM synth | ~90 BPM | 139 BPM, cuts on the beat | 94 BPM ambient |

What the references do that v1 doesn't:
- **Arc**: full-screen word cards ("everything" / "nothing") cut on the beat between footage; the product shows up late; ends on a solid brand-colour card with just the URL.
- **Raycast**: macro close-ups where one UI element fills the frame (a giant search field, a single row), minimal on-screen text, mono uppercase end titles. Its most-replayed moment is the end title.
- **Linear**: a calm single take works for an established brand. It's not the energy we want for a launch.

What v1 measured badly:
- The 6–26 s product section reads as **one 20 s shot**: same dark window, same orange 9:16 frame and the same composition in every beat. Beats change inside the shot but never feel like cuts.
- True peak +1.0 dBFS clips after encoding. The voice note and the before/after audio sit only ~3 dB over the music.
- The first 0.5 s is black.

## v2 rules
1. Words on screen from frame 0.
2. Each beat = a 0.5 s full-bleed colour card on the beat ("Box it." lime, "Select it." coral, "Say it." bone, "Claude fixes it." violet), then 2–3 shots at different scales: one wide-ish, one macro (the composer, the transcript words, the feedback card, the mic).
3. Target 20–30 cuts/min through the demo; average shot about 1.5 s.
4. Small captions only inside shots; the cards carry the beat names.
5. End on a full-bleed lime card: `npx cutroom` plus the repo URL.
6. Mix to about −12 LUFS with true peak ≤ −1 dBFS; dialogue ≥ 12 dB over the bed; a sound on every cut, a click on every click, a pop when a note is sent, a chime when Claude resolves one.
7. Real voices (ElevenLabs) for the presenter and the voice note; ElevenLabs sound effects for whooshes, impacts, clicks and typing.

## v3: story and fun (from the reference the user picked)

Reference: a 15 s motion-design launch film on X (1.76 M views in 4 days). Measured: 27.9 cuts/min, median shot 0.76 s, no voice, −14 LUFS. It's fun because of three things:
- **A physical joke as the hook.** A cursor switches off "Reduce Motion", and the letters swing and fall apart.
- **One hero object with real physics.** The orange dot of the "i" bounces with squash and stretch, morphs into shapes and carries the whole film.
- **A deadpan punchline.** "Motion designer. **0** keyframes."

Our version keeps that structure but tells our story:
1. **The gag (0–3.5 s):** "you, editing a video with a chatbot:" A prompt box fills with "move me a bit to the left.. no, MY left.. cut at 0:05.. no, the OTHER 0:05..", strains, inflates and bursts. The letters fall out of frame.
2. **The hero (3.5–6 s):** our coral pin drops in and lands as the full stop of "Stop describing", then hops onto the i of "Just point." Zoom into the pin.
3. **The power (6–9 s):** point at the frame, or the words, or just say it, cut on the beat in coral, ink and cream. Then "Claude fixes it."
4. **The proof (9–25.5 s):** the real editor. Beat cards ("Box it", "On it", "Select it", "Say it", "All fixed") with the pin as their full stop.
5. **The payoff:** before/after, then a 3D type ring (BOX IT · SELECT IT · SAY IT · CLAUDE FIXES IT) circling the pin.
6. **Punchline:** "Video editor. **0** timelines." in near silence.
7. **End:** the pin drops onto the cutroom wordmark, then `npx cutroom`.

Palette: cream #efebe3, ink #141210, coral #ff5a3c, with violet and lime as accents. 60 fps.

## v4: premium, no voice

v3 read as cheap. These were the reasons:
- The illustrated presenter.
- Bouncing letters.
- Loud full-bleed colour cards.
- Cartoon sound effects.

v4 keeps the story and drops the gimmicks:
- **Real footage.** A photoreal talking head made with the Grok CLI, sitting off-centre so the vertical crop cuts him off. The take has a real "Umm" to cut.
- **Three lines of type that carry the story.** "Editing video with AI / means describing every edit." Then a prompt field types "move the speaker a bit to the left… no, the other left…", gets selected and deleted. Then "What if you could just point?", where the cursor boxes the word "point".
- **The real editor, floating on near-black.** Slow camera moves, 0.28 s crossfades and quiet captions: "01 Point at the frame", "Claude reframes the shot", "02 Or select the words", "Claude cuts it", "03 Or just ask", "Claude does the edit".
- **Before / after** of the real export in phone frames.
- **Then** "Video editor. 0 timelines." and the end card with the app icon and `npx cutroom`.
- **Type:** blur-in reveals with expo easing; nothing bounces.
- **Sound:** no voice anywhere. A 100 BPM felt-piano score with a sub pulse, mastered to −14 LUFS.

## v5: slower, and says what it is

Feedback on v4: 12–25 s went by too fast, and the film never said cutroom is an MCP editor for Claude.
- **What it is (8.4–12 s):** a new beat, "cutroom is a video editor built for Claude. You point at what's wrong. Claude makes the edit, over MCP.", with a small cutroom ⟷ MCP ⟷ Claude diagram.
- **The product runs about 20 s instead of 13:** user turns at 1.1×, Claude's turns in real time, each beat as two calm shots.
  - What you do: the full editor.
  - What Claude does: the editor beside a "Claude · connected to cutroom over MCP" panel streaming the real tool calls (`wait_for_feedback`, `update_feedback → working`, `edit set_focus` / `remove_words` / `set_captions`, `→ resolved`) in sync with the picture.
- **The capture runs the turns in sequence:** the user waits for Claude to resolve each note before the next action, so no shot shows two things at once.
- **The end card shows the setup command:** `claude mcp add cutroom -- npx -y cutroom mcp`.
