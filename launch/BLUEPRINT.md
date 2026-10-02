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
